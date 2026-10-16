#!/usr/bin/env python3
"""On-air state of the Winline EPL plates: what each broadcast channel shows right now.

  python -I tools/epl_onair.py [--port 8096] [--state PATH] [--key-file PATH]

Runs on the Moscow server behind Caddy (/api/onair/* -> 127.0.0.1:8096), so the overlay page in OBS / vMix and the
operator's phone reach it without a VPN; the Cloudflare worker forwards the same paths here.

  GET  /api/onair/state?room=1     the overlay polls this: {room, version, on, plate, id, updated_at}
  GET  /api/onair/rooms            every channel's state (the operator site shows it)
  POST /api/onair/show   {room, id, match, plate}   put a plate on air           (operator key)
  POST /api/onair/hide   {room}                     take the channel's plate off (operator key)
  POST /api/onair/off-all                           every channel off            (operator key)
  GET  /api/onair/check                             is this operator key right?  (operator key)

The operator key comes in the header X-Operator-Key (or Authorization: Bearer). After MAX_FAILURES wrong keys
within FAILURE_WINDOW seconds every keyed request is refused for the rest of the window. The state is kept in a
JSON file (written atomically), so a restart does not drop what is on air.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOM_RE = re.compile(r"^[a-z0-9-]{1,20}$")
TEXT_LIMIT = 200
MAX_BODY = 16 * 1024
MAX_FAILURES = 20
FAILURE_WINDOW = 600
PLATE_TEXTS = ("headline", "team", "bet")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def clean_plate(raw) -> dict:
    """Only the fields the overlay draws, with sane types and lengths; raises ValueError on garbage."""
    if not isinstance(raw, dict):
        raise ValueError("plate must be an object")
    plate = {key: str(raw.get(key) or "")[:TEXT_LIMIT] for key in PLATE_TEXTS}
    odds = raw.get("odds")
    if odds is not None:
        odds = float(str(odds).replace(",", "."))
        if not 1.0 <= odds <= 1000.0:
            raise ValueError("odds out of range")
    plate["odds"] = odds
    crests = raw.get("crests") or []
    if not isinstance(crests, list) or len(crests) > 2:
        raise ValueError("crests must be a list of up to two club ids")
    plate["crests"] = [int(c) for c in crests]
    plate["crestWhole"] = bool(raw.get("crestWhole"))
    if not any(plate[key] for key in PLATE_TEXTS):
        raise ValueError("empty plate")
    return plate


class OnAir:
    def __init__(self, state_path: Path, key: str):
        self.path = state_path
        self.key = key
        self.lock = threading.Lock()
        self.failures: list[float] = []
        self.rooms: dict[str, dict] = {}
        if state_path.exists():
            try:
                self.rooms = json.loads(state_path.read_text(encoding="utf-8")).get("rooms", {})
            except (OSError, ValueError):
                self.rooms = {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        partial = self.path.with_name(self.path.name + ".part")
        partial.write_text(json.dumps({"rooms": self.rooms}, ensure_ascii=False), encoding="utf-8")
        os.replace(partial, self.path)

    def room(self, name: str) -> dict:
        return self.rooms.get(name) or {"room": name, "version": 0, "on": False, "plate": None, "id": None, "match": None, "updated_at": None}

    def authorized(self, given: str) -> tuple[bool, str | None]:
        with self.lock:
            moment = time.monotonic()
            self.failures = [t for t in self.failures if moment - t < FAILURE_WINDOW]
            if len(self.failures) >= MAX_FAILURES:
                return False, "too_many_attempts"
            if given and self.key and hmac.compare_digest(given.encode(), self.key.encode()):
                return True, None
            self.failures.append(moment)
            return False, "unauthorized"

    def change(self, name: str, **fields) -> dict:
        with self.lock:
            state = {**self.room(name), **fields, "room": name, "updated_at": now_iso()}
            state["version"] = int(state.get("version") or 0) + 1
            self.rooms[name] = state
            self.save()
            return state

    def off_all(self) -> list[dict]:
        with self.lock:
            changed = []
            for state in self.rooms.values():
                if state.get("on"):
                    state.update(on=False, updated_at=now_iso(), version=int(state.get("version") or 0) + 1)
                    changed.append(state)
            self.save()
            return changed


def make_handler(onair: OnAir):
    class Handler(BaseHTTPRequestHandler):
        server_version = "hoh-epl-onair"

        def log_message(self, fmt, *args):  # one short line per write, nothing per poll
            if self.command == "POST":
                sys.stderr.write(f"{now_iso()} {self.command} {self.path} {fmt % args}\n")

        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def room_name(self, value) -> str | None:
            name = str(value or "1").strip().lower()
            return name if ROOM_RE.match(name) else None

        def operator_key(self) -> str:
            key = self.headers.get("X-Operator-Key") or ""
            if not key:
                auth = self.headers.get("Authorization") or ""
                key = auth[7:] if auth.lower().startswith("bearer ") else ""
            return key.strip()

        def do_GET(self):
            url = urlparse(self.path)
            query = parse_qs(url.query)
            if url.path == "/api/onair/state":
                name = self.room_name((query.get("room") or ["1"])[0])
                return self.reply(200, {"ok": True, **onair.room(name)}) if name else self.reply(400, {"ok": False, "error": "bad_room"})
            if url.path == "/api/onair/rooms":
                return self.reply(200, {"ok": True, "rooms": sorted(onair.rooms.values(), key=lambda r: r["room"])})
            if url.path == "/api/onair/check":
                ok, error = onair.authorized(self.operator_key())
                return self.reply(200 if ok else (429 if error == "too_many_attempts" else 401), {"ok": ok, **({"error": error} if error else {})})
            if url.path == "/api/onair/health":
                return self.reply(200, {"ok": True, "rooms": len(onair.rooms)})
            return self.reply(404, {"ok": False, "error": "not_found"})

        def do_POST(self):
            url = urlparse(self.path)
            ok, error = onair.authorized(self.operator_key())
            if not ok:
                return self.reply(429 if error == "too_many_attempts" else 401, {"ok": False, "error": error})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.reply(413, {"ok": False, "error": "too_large"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("body must be an object")
            except ValueError as problem:
                return self.reply(400, {"ok": False, "error": f"bad_json: {problem}"})
            if url.path == "/api/onair/off-all":
                return self.reply(200, {"ok": True, "changed": onair.off_all()})
            name = self.room_name(body.get("room"))
            if not name:
                return self.reply(400, {"ok": False, "error": "bad_room"})
            if url.path == "/api/onair/show":
                try:
                    plate = clean_plate(body.get("plate"))
                except (TypeError, ValueError) as problem:
                    return self.reply(400, {"ok": False, "error": f"bad_plate: {problem}"})
                state = onair.change(name, on=True, plate=plate, id=str(body.get("id") or "")[:TEXT_LIMIT] or None,
                                     match=str(body.get("match") or "")[:TEXT_LIMIT] or None)
                return self.reply(200, {"ok": True, **state})
            if url.path == "/api/onair/hide":
                return self.reply(200, {"ok": True, **onair.change(name, on=False)})
            return self.reply(404, {"ok": False, "error": "not_found"})

    return Handler


def read_key(path: str | None) -> str:
    if not path:
        return ""
    return Path(path).read_text(encoding="ascii").strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8096)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--state", default=os.path.join(os.environ.get("STATE_DIRECTORY", "."), "onair.json"))
    parser.add_argument("--key-file", default=os.path.join(os.environ.get("CREDENTIALS_DIRECTORY", "."), "operator.key"))
    args = parser.parse_args(argv)
    key = read_key(args.key_file)
    if len(key) < 8:
        raise SystemExit("operator key missing or shorter than 8 characters")
    server = ThreadingHTTPServer((args.host, args.port), make_handler(OnAir(Path(args.state), key)))
    sys.stderr.write(f"{now_iso()} on-air service on {args.host}:{args.port}, state {args.state}\n")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
