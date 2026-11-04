#!/usr/bin/env python3
"""Matchday: the tennis match page with Winline's line and what goes with it, served on the shared
server at /matchday of the «Больше» address. Read-only over tennis.sqlite, which the snapshot, collector
and parse units keep fresh; it changes nothing and holds no accounts.

The shape follows the EPL operator site: matches by day, /matchday/#matches/<Winline id>, tabs for
plates and markets. A plate is a fact next to a real price, never a claim that a bet is good.

    python tools/tennis/matchday_server.py --port 8107
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wta_plates  # noqa: E402

DEFAULT_DB = HERE.parents[1] / "local-data" / "tennis" / "tennis.sqlite"
SITE = HERE / "matchday_site"
PREFIX = "/matchday"
STATIC = {"app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8",
          "index.html": "text/html; charset=utf-8"}
MOVE = 0.03  # a price counts as moved at 3 %, as on the EPL site
RECENT_DAYS = 2
HISTORY_TTL = 600
PLATE_NOTE = "Плашки пока только для одиночного разряда WTA"


def open_db(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


class History:
    """Results and player links, reloaded at most every 10 minutes: the parse unit runs hourly."""

    def __init__(self, path: Path, ttl: float = HISTORY_TTL):
        self.path, self.ttl = path, ttl
        self.lock = threading.Lock()
        self.loaded_at = 0.0
        self.players = self.ids = self.surfaces = self.learned = {}

    def get(self):
        with self.lock:
            if time.monotonic() - self.loaded_at >= self.ttl or not self.loaded_at:
                db = open_db(self.path)
                db.row_factory = None
                self.players = wta_plates.load_history(db)
                self.ids = wta_plates.player_index(db)
                self.surfaces = wta_plates.surface_index(db)
                self.learned = wta_plates.learned_players(db, self.ids)
                db.close()
                self.loaded_at = time.monotonic()
            return self.players, self.ids, self.surfaces, self.learned


def family_of(market: str) -> tuple[int, str]:
    """(place in the page, family name). Set markets come after the whole-match ones."""
    if market == "Победитель":
        return 0, "Исход матча"
    if market == "Фора":
        return 1, "Фора по геймам"
    if market == "Тотал":
        return 2, "Тотал геймов"
    found = re.match(r"(\d+) сет (Исход|Фора|Тотал)", market)
    if found:
        kind = {"Исход": "исход", "Фора": "фора", "Тотал": "тотал"}[found.group(2)]
        return 10 + int(found.group(1)), f"{found.group(1)} сет: {kind}"
    return 90, market


def moved(now: float, first: float) -> bool:
    return bool(first) and abs(now / first - 1) >= MOVE


def group_markets(rows: list[dict], team1: str | None, team2: str | None) -> list[dict]:
    """Rows of winline_line, oldest first, into families of rungs with their price history."""
    rungs: dict[tuple, dict] = {}
    for row in rows:
        key = (row["market"], row["value_key"])
        rung = rungs.setdefault(key, {"market": row["market"], "value": row["value"], "history": []})
        rung["history"].append({"at": row["taken_at"], "odd1": row["odd1"], "odd2": row["odd2"]})
    families: dict[tuple, dict] = {}
    for rung in rungs.values():
        first, last = rung["history"][0], rung["history"][-1]
        rung.update(odd1=last["odd1"], odd2=last["odd2"], was1=first["odd1"] if moved(last["odd1"], first["odd1"]) else None,
                    was2=first["odd2"] if moved(last["odd2"], first["odd2"]) else None)
        order, name = family_of(rung["market"])
        total = "Тотал" in rung["market"]
        family = families.setdefault((order, name), {"name": name, "side1": "Больше" if total else team1,
                                                     "side2": "Меньше" if total else team2, "rungs": []})
        family["rungs"].append(rung)
    for family in families.values():
        family["rungs"].sort(key=lambda r: (r["value"] is not None, r["value"] or 0))
    return [families[key] for key in sorted(families)]


def latest_lines(db: sqlite3.Connection, wl_id: str) -> list[dict]:
    # MAX with bare columns gives the columns of the row holding the maximum, in SQLite.
    return [dict(r) for r in db.execute(
        """SELECT market, value, odd1, odd2, MAX(taken_at) AS taken_at FROM winline_line
           WHERE wl_id = ? GROUP BY market, value_key""", (wl_id,))]


def last_fetch(db: sqlite3.Connection) -> dict:
    row = db.execute("SELECT taken_at, events, lines, changed FROM winline_fetch ORDER BY taken_at DESC LIMIT 1").fetchone()
    return dict(row) if row else {}


def plates_for(event: dict, lines: list[dict], history: History) -> dict | None:
    if event["circuit"] != "WTA" or event["is_doubles"]:
        return None
    players, ids, surfaces, learned = history.get()
    return wta_plates.build(event, lines, players, ids, surfaces, learned)


def list_matches(db: sqlite3.Connection, history: History, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    fetch = last_fetch(db)
    if not fetch:
        return {"fetch": {}, "matches": []}
    since = (now - timedelta(days=RECENT_DAYS)).isoformat(timespec="seconds")
    events = [dict(r) for r in db.execute(
        "SELECT * FROM winline_event WHERE last_seen = ? OR last_seen >= ? ORDER BY start_at", (fetch["taken_at"], since))]
    ids = json.dumps([e["wl_id"] for e in events])
    winners = {r["wl_id"]: r for r in db.execute(
        """SELECT wl_id, odd1, odd2, MAX(taken_at) FROM winline_line
           WHERE wl_id IN (SELECT value FROM json_each(?)) AND market = 'Победитель' GROUP BY wl_id""", (ids,))}
    counts = dict(db.execute(
        """SELECT wl_id, COUNT(DISTINCT market || '|' || value_key) FROM winline_line
           WHERE wl_id IN (SELECT value FROM json_each(?)) GROUP BY wl_id""", (ids,)).fetchall())
    matches = []
    for event in events:
        winner = winners.get(event["wl_id"])
        in_line = event["last_seen"] == fetch["taken_at"]
        plates = 0
        if in_line and event["circuit"] == "WTA" and not event["is_doubles"]:
            built = plates_for(event, latest_lines(db, event["wl_id"]), history)
            plates = len(built["lines"]) if built else 0
        matches.append({
            "id": event["wl_id"], "circuit": event["circuit"], "tournament": event["tournament"], "team1": event["team1"],
            "team2": event["team2"], "start_at": event["start_at"], "is_doubles": bool(event["is_doubles"]), "in_line": in_line,
            "odd1": winner["odd1"] if winner else None, "odd2": winner["odd2"] if winner else None,
            "markets": counts.get(event["wl_id"], 0), "plates": plates,
        })
    return {"fetch": fetch, "matches": matches}


def past_results(db: sqlite3.Connection, where: str, values: tuple, limit: int) -> list[dict]:
    rows = db.execute(
        f"""SELECT m.winner_id, m.loser_id, m.score, m.status, m.round, COALESCE(m.match_date, t.start_date) AS played,
                   t.name AS tournament, t.level, t.surface, w.full_name AS winner, l.full_name AS loser
            FROM wta_match m JOIN wta_tournament t ON t.group_id = m.group_id AND t.year = m.year
            LEFT JOIN wta_player w ON w.player_id = m.winner_id LEFT JOIN wta_player l ON l.player_id = m.loser_id
            WHERE m.discipline = 'S' AND m.status IN ('completed', 'retired') AND ({where})
            ORDER BY played DESC LIMIT ?""", (*values, limit))
    return [dict(r) for r in rows]


def match_detail(db: sqlite3.Connection, history: History, wl_id: str) -> dict | None:
    row = db.execute("SELECT * FROM winline_event WHERE wl_id = ?", (wl_id,)).fetchone()
    if row is None:
        return None
    event = dict(row)
    rows = [dict(r) for r in db.execute(
        "SELECT market, value_key, value, odd1, odd2, taken_at FROM winline_line WHERE wl_id = ? ORDER BY taken_at", (wl_id,))]
    built = plates_for(event, latest_lines(db, wl_id), history)
    detail = {
        "id": wl_id, "circuit": event["circuit"], "tournament": event["tournament"], "team1": event["team1"], "team2": event["team2"],
        "start_at": event["start_at"], "url": event["url"], "is_doubles": bool(event["is_doubles"]),
        "first_seen": event["first_seen"], "last_seen": event["last_seen"], "fetch": last_fetch(db),
        "markets": group_markets(rows, event["team1"], event["team2"]),
        "facts": [], "lines": [], "notes": [], "h2h": [], "form": [],
    }
    if built is None:
        detail["notes"].append(PLATE_NOTE)
        return detail
    detail.update(facts=built["facts"], lines=built["lines"], notes=built["notes"])
    ids = built.get("wta_ids")
    if ids:
        first, second = ids
        cutoff = (event["start_at"] or "9")[:10]
        detail["h2h"] = past_results(
            db, "((m.winner_id = ? AND m.loser_id = ?) OR (m.winner_id = ? AND m.loser_id = ?)) AND COALESCE(m.match_date, t.start_date) < ?",
            (first, second, second, first, cutoff), 30)
        detail["form"] = [
            {"name": name, "results": past_results(db, "(m.winner_id = ? OR m.loser_id = ?) AND COALESCE(m.match_date, t.start_date) < ?",
                                                   (pid, pid, cutoff), 10), "player_id": pid}
            for pid, name in ((first, event["team1"]), (second, event["team2"]))
        ]
    return detail


class Handler(BaseHTTPRequestHandler):
    server_version = "matchday"
    sys_version = ""

    def respond(self, status: int, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status: int = 200) -> None:
        self.respond(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802 - the name http.server asks for
        path = urlsplit(self.path).path
        try:
            self.route(path)
        except sqlite3.OperationalError as error:
            self.log_error("database: %s", error)
            self.send_json({"error": "база занята, попробуйте ещё раз"}, 503)
        except BrokenPipeError:
            pass

    def route(self, path: str) -> None:
        if path == PREFIX:
            self.send_response(302)
            self.send_header("Location", f"{PREFIX}/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == f"{PREFIX}/":
            self.static("index.html")
            return
        if not path.startswith(f"{PREFIX}/"):
            self.send_json({"error": "not found"}, 404)
            return
        rest = path[len(PREFIX) + 1:]
        if rest in STATIC:
            self.static(rest)
        elif rest == "api/health":
            db = open_db(self.server.db_path)
            self.send_json({"ok": True, "fetch": last_fetch(db)})
            db.close()
        elif rest == "api/matches":
            db = open_db(self.server.db_path)
            self.send_json(list_matches(db, self.server.history))
            db.close()
        else:
            found = re.fullmatch(r"api/matches/(\d{1,20})", rest)
            if not found:
                self.send_json({"error": "not found"}, 404)
                return
            db = open_db(self.server.db_path)
            detail = match_detail(db, self.server.history, found.group(1))
            db.close()
            self.send_json(detail if detail else {"error": "нет такого матча"}, 200 if detail else 404)

    def static(self, name: str) -> None:
        self.respond(200, (SITE / name).read_bytes(), STATIC[name], "no-cache")

    def log_message(self, format, *args) -> None:  # noqa: A002 - only problems go to the journal
        if args and str(args[0]).startswith("database"):
            super().log_message(format, *args)


def make_server(db_path: Path, port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    server.db_path = db_path
    server.history = History(db_path)
    return server


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--port", type=int, default=8107)
    args = parser.parse_args()
    make_server(args.db, args.port).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
