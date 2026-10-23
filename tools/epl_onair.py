#!/usr/bin/env python3
"""On-air state of the Winline EPL plates and the commentators' accounts (one room per match).

  python -I tools/epl_onair.py [--port 8096] [--state-dir DIR] [--smtp FILE]          the service
  python -I tools/epl_onair.py users list|invite|access|reset ... [--state-dir DIR]   accounts from the server's shell

Runs on the Moscow server behind Caddy (/api/onair/* -> 127.0.0.1:8096); the Cloudflare worker forwards the same paths.
Owner 2026-10-23: the site and every button work only after a login (e-mail + password, sent by e-mail and changeable
in the personal page); two roles: a commentator puts plates on air, an admin also gives and takes the commentators'
access; who put which plate on air and when is kept for good (history.jsonl).

  GET  /api/onair/state?room=<id>   the OBS / vMix overlay polls this (no login): {room, version, on, plate, id, updated_at}
  GET  /api/onair/health            no login
  GET  /api/onair/auth              Caddy forward_auth / the worker: 200 when logged in, else 401 (data) or 302 to /login.html
  POST /api/onair/login  {email, password}       sets the session cookie
  POST /api/onair/logout
  GET  /api/onair/me                             the person logged in
  POST /api/onair/password {old, new}            change one's own password (other sessions are closed)
  GET  /api/onair/rooms                          every match's state, with who put the plate on air
  POST /api/onair/show   {room, id, match, plate}
  POST /api/onair/hide   {room}
  GET  /api/onair/users                          admin: everybody with access and without
  POST /api/onair/users/add    {name, email}     admin: a new commentator; the password goes by e-mail
  POST /api/onair/users/access {email, active}   admin: take a commentator's access away / give it back
  POST /api/onair/users/reset  {email}           admin: a new password by e-mail
  GET  /api/onair/history?room=&email=&limit=    admin: who did what, newest first

The session is an HttpOnly cookie; POSTs must be JSON (a cross-site form cannot send that). Passwords are kept only
as scrypt hashes. After ACCOUNT_FAILURES wrong passwords for one e-mail within ACCOUNT_WINDOW seconds that account is
locked for the rest of the window; GLOBAL_FAILURES within GLOBAL_WINDOW lock every login. There is deliberately no
«everything off»: several broadcasts share the service and nobody may clear the others' plates. Rooms that are off and
untouched for ROOM_TTL_DAYS are dropped on the next change. Without an SMTP file the new password comes back in the
answer once (the admin passes it on), so the accounts work before the mail does.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOM_RE = re.compile(r"^[a-z0-9-]{1,20}$")
EMAIL_RE = re.compile(r"^[^@\s,;<>\"']{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$")
TEXT_LIMIT = 200
NAME_LIMIT = 80
MAX_BODY = 16 * 1024
PLATE_TEXTS = ("headline", "team", "bet")
ROOM_TTL_DAYS = 14
ROLES = ("admin", "commentator")
COOKIE = "epl_session"
SESSION_DAYS = 60
PASSWORD_MIN = 8
PASSWORD_MAX = 128
PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i: read from a letter and typed on a phone
ACCOUNT_FAILURES, ACCOUNT_WINDOW = 8, 900
GLOBAL_FAILURES, GLOBAL_WINDOW = 200, 600
HISTORY_ROWS = 1000
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}
SITE_URL = "https://epl.109-172-113-187.sslip.io"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def iso_after(days: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, maxmem=64 * 1024 * 1024, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt, digest = stored.split("$")
        if kind != "scrypt":
            return False
        got = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                             maxmem=64 * 1024 * 1024, dklen=len(digest) // 2)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), digest)


DUMMY_HASH = hash_password(secrets.token_hex(8))  # an unknown e-mail costs the same time as a wrong password


def new_password() -> str:
    """Ten characters in two groups of five: k7m2p-9xq4t (about 50 bits)."""
    raw = "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def clean_email(value) -> str:
    email = str(value or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise ValueError("bad_email")
    return email


def clean_name(value) -> str:
    name = " ".join(str(value or "").split())[:NAME_LIMIT]
    if len(name) < 2:
        raise ValueError("bad_name")
    return name


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


def public_user(user: dict) -> dict:
    return {key: user.get(key) for key in ("email", "name", "role", "active", "created_at", "created_by", "last_login")}


# ---------- mail: the password goes to the person's e-mail ----------
INVITE_SUBJECT = "Доступ к плашкам Winline на АПЛ"
RESET_SUBJECT = "Новый пароль к плашкам Winline на АПЛ"
INVITE_TEXT = """{first}, привет!

Это доступ к сайту плашек Winline для трансляций АПЛ

Сайт: {site}
Логин: {email}
Пароль: {password}

Пароль можно поменять в личном кабинете, это кнопка с вашим именем вверху сайта
Общая ссылка с ключом больше не работает, теперь каждый заходит под своим логином
{admin}
--
Игорь Знаменский"""
ADMIN_LINE = "\nУ вас права администратора: в разделе Комментаторы можно дать доступ новому комментатору или забрать его\n"
RESET_TEXT = """{first}, привет!

Новый пароль к сайту плашек Winline на АПЛ

Сайт: {site}
Логин: {email}
Пароль: {password}

Поменять его можно в личном кабинете, это кнопка с вашим именем вверху сайта

--
Игорь Знаменский"""


def read_env(path: Path) -> dict:
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class Mailer:
    """SMTP over SSL from a KEY=VALUE file: SMTP_HOST, SMTP_PORT (465), SMTP_LOGIN, SMTP_PASSWORD, MAIL_FROM_NAME."""

    def __init__(self, path: Path | None):
        self.config = read_env(path) if path and path.exists() else {}

    @property
    def ready(self) -> bool:
        return all(self.config.get(k) for k in ("SMTP_HOST", "SMTP_LOGIN", "SMTP_PASSWORD"))

    def send(self, to_email: str, to_name: str, subject: str, text: str) -> None:
        message = EmailMessage()
        message["From"] = formataddr((self.config.get("MAIL_FROM_NAME") or "Игорь Знаменский", self.config["SMTP_LOGIN"]))
        message["To"] = formataddr((to_name, to_email))
        message["Subject"] = subject
        message["Message-ID"] = make_msgid(domain=self.config["SMTP_LOGIN"].split("@")[-1])
        message.set_content(text)
        port = int(self.config.get("SMTP_PORT") or 465)
        with smtplib.SMTP_SSL(self.config["SMTP_HOST"], port, context=ssl.create_default_context(), timeout=30) as smtp:
            smtp.login(self.config["SMTP_LOGIN"], self.config["SMTP_PASSWORD"])
            smtp.send_message(message)


def letter(user: dict, password: str, kind: str) -> tuple[str, str]:
    fields = {"first": user["name"].split()[0], "site": SITE_URL, "email": user["email"], "password": password,
              "admin": ADMIN_LINE if user["role"] == "admin" else ""}
    if kind == "reset":
        return RESET_SUBJECT, RESET_TEXT.format(**fields)
    return INVITE_SUBJECT, INVITE_TEXT.format(**fields)


# ---------- the state: rooms, accounts, sessions, history ----------
def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    partial.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(partial, 0o600)
    os.replace(partial, path)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


class Service:
    def __init__(self, state_dir: Path, mailer: Mailer | None = None):
        self.dir = state_dir
        self.mailer = mailer or Mailer(None)
        self.lock = threading.RLock()
        self.rooms: dict[str, dict] = read_json(self.dir / "onair.json", {}).get("rooms", {})
        self.sessions: dict[str, dict] = read_json(self.dir / "sessions.json", {})
        self.users: dict[str, dict] = {}
        self.users_mtime = None
        self.failures: dict[str, list[float]] = {}
        self.global_failures: list[float] = []
        self.reload_users()

    # accounts may also be changed from the server's shell (`users` command): read the file again when it changed
    def reload_users(self) -> None:
        path = self.dir / "users.json"
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            mtime = None
        if mtime != self.users_mtime:
            self.users = read_json(path, {}).get("users", {})
            self.users_mtime = mtime

    def save_users(self) -> None:
        write_json(self.dir / "users.json", {"users": self.users})
        self.users_mtime = (self.dir / "users.json").stat().st_mtime_ns

    def save_sessions(self) -> None:
        write_json(self.dir / "sessions.json", self.sessions)

    def save_rooms(self) -> None:
        write_json(self.dir / "onair.json", {"rooms": self.rooms})

    def record(self, action: str, actor: dict | None, **fields) -> None:
        row = {"at": now_iso(), "action": action, "email": (actor or {}).get("email"), "name": (actor or {}).get("name"), **fields}
        self.dir.mkdir(parents=True, exist_ok=True)
        with open(self.dir / "history.jsonl", "a", encoding="utf-8") as out:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")

    def history(self, room: str | None = None, email: str | None = None, limit: int = HISTORY_ROWS) -> list[dict]:
        try:
            lines = (self.dir / "history.jsonl").read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        out = []
        for raw in reversed(lines):
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if (room and row.get("room") != room) or (email and row.get("email") != email and row.get("target") != email):
                continue
            out.append(row)
            if len(out) >= limit:
                break
        return out

    # ---- logins and sessions ----
    def locked(self, email: str) -> bool:
        moment = time.monotonic()
        self.global_failures = [t for t in self.global_failures if moment - t < GLOBAL_WINDOW]
        recent = [t for t in self.failures.get(email, []) if moment - t < ACCOUNT_WINDOW]
        self.failures[email] = recent
        return len(self.global_failures) >= GLOBAL_FAILURES or len(recent) >= ACCOUNT_FAILURES

    def login(self, email_raw, password, ip: str = "") -> tuple[str | None, dict | None, str | None]:
        """(token, user, None) or (None, None, error): bad_login / locked / no_access."""
        try:
            email = clean_email(email_raw)
        except ValueError:
            return None, None, "bad_login"
        password = str(password or "")[:PASSWORD_MAX]
        with self.lock:
            self.reload_users()
            if self.locked(email):
                return None, None, "locked"
            user = self.users.get(email)
        good = check_password(password, user["hash"] if user else DUMMY_HASH)  # outside the lock: scrypt is slow
        with self.lock:
            if not user or not good:
                moment = time.monotonic()
                self.failures.setdefault(email, []).append(moment)
                self.global_failures.append(moment)
                return None, None, "bad_login"
            if not user.get("active"):
                return None, None, "no_access"
            token = secrets.token_urlsafe(32)
            stamp = now_iso()
            self.sessions = {k: s for k, s in self.sessions.items() if s.get("expires_at", "") > stamp}
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = {"email": email, "created_at": stamp, "expires_at": iso_after(SESSION_DAYS)}
            self.save_sessions()
            user["last_login"] = stamp
            self.save_users()
            self.failures.pop(email, None)
            self.record("login", user, ip=ip[:64])
            return token, user, None

    def session_user(self, token: str | None) -> dict | None:
        if not token:
            return None
        with self.lock:
            self.reload_users()
            session = self.sessions.get(hashlib.sha256(token.encode()).hexdigest())
            if not session or session.get("expires_at", "") <= now_iso():
                return None
            user = self.users.get(session["email"])
            return user if user and user.get("active") else None

    def logout(self, token: str | None) -> None:
        if token:
            with self.lock:
                if self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None):
                    self.save_sessions()

    def drop_sessions(self, email: str, keep: str | None = None) -> None:
        keep_hash = hashlib.sha256(keep.encode()).hexdigest() if keep else None
        self.sessions = {k: s for k, s in self.sessions.items() if s.get("email") != email or k == keep_hash}
        self.save_sessions()

    def change_password(self, user: dict, old: str, new: str, token: str | None) -> str | None:
        new = str(new or "")
        if not PASSWORD_MIN <= len(new) <= PASSWORD_MAX:
            return "weak_password"
        if not check_password(str(old or "")[:PASSWORD_MAX], user["hash"]):
            return "wrong_password"
        with self.lock:
            self.reload_users()
            current = self.users.get(user["email"])
            if not current:
                return "no_access"
            current["hash"] = hash_password(new)
            current["password_changed_at"] = now_iso()
            self.save_users()
            self.drop_sessions(user["email"], keep=token)
            self.record("password", current)
        return None

    # ---- accounts (admins from the site, the owner from the shell) ----
    def add_user(self, name, email, role: str, by: dict | None) -> tuple[dict, str]:
        name, email = clean_name(name), clean_email(email)
        if role not in ROLES:
            raise ValueError("bad_role")
        password = new_password()
        with self.lock:
            self.reload_users()
            if email in self.users:
                raise ValueError("exists")
            user = {"email": email, "name": name, "role": role, "active": True, "hash": hash_password(password),
                    "created_at": now_iso(), "created_by": (by or {}).get("email") or "server", "last_login": None}
            self.users[email] = user
            self.save_users()
            self.record("user_add", by, target=email, target_name=name, role=role)
        return user, password

    def set_access(self, email, active: bool, by: dict | None) -> dict:
        email = clean_email(email)
        with self.lock:
            self.reload_users()
            user = self.users.get(email)
            if not user:
                raise ValueError("no_user")
            if by is not None and (user["role"] != "commentator" or email == by.get("email")):
                raise ValueError("not_allowed")  # admins manage commentators; admins themselves only from the shell
            user["active"] = bool(active)
            self.save_users()
            if not active:
                self.drop_sessions(email)
            self.record("access_on" if active else "access_off", by, target=email, target_name=user["name"])
            return user

    def reset_password(self, email, by: dict | None) -> tuple[dict, str]:
        email = clean_email(email)
        password = new_password()
        with self.lock:
            self.reload_users()
            user = self.users.get(email)
            if not user:
                raise ValueError("no_user")
            if by is not None and user["role"] != "commentator":
                raise ValueError("not_allowed")
            user["hash"] = hash_password(password)
            user["password_changed_at"] = now_iso()
            self.save_users()
            self.drop_sessions(email)
            self.record("password_reset", by, target=email, target_name=user["name"])
        return user, password

    def deliver(self, user: dict, password: str, kind: str) -> bool:
        """Mail the password; False when there is no mail set up or it failed (the caller shows the password once)."""
        if not self.mailer.ready:
            return False
        subject, text = letter(user, password, kind)
        try:
            self.mailer.send(user["email"], user["name"], subject, text)
        except (OSError, smtplib.SMTPException) as problem:
            sys.stderr.write(f"{now_iso()} mail to {user['email']} failed: {type(problem).__name__}: {problem}\n")
            return False
        self.record("mail", None, target=user["email"], kind=kind)
        return True

    # ---- rooms ----
    def room(self, name: str) -> dict:
        return self.rooms.get(name) or {"room": name, "version": 0, "on": False, "plate": None, "id": None, "match": None, "by": None, "updated_at": None}

    def change(self, name: str, actor: dict, **fields) -> dict:
        with self.lock:
            state = {**self.room(name), **fields, "room": name, "by": actor["name"], "updated_at": now_iso()}
            state["version"] = int(state.get("version") or 0) + 1
            self.rooms[name] = state
            self.prune()
            self.save_rooms()
            plate = state.get("plate") or {}
            self.record("show" if fields.get("on") else "hide", actor, room=name, match=state.get("match"), id=state.get("id"),
                        plate={k: plate.get(k) for k in ("headline", "team", "bet", "odds")} if fields.get("on") else None)
            return state

    def prune(self) -> None:
        """Forget rooms of past matches: off and not touched for ROOM_TTL_DAYS (ISO times compare as text)."""
        cutoff = datetime.fromtimestamp(time.time() - ROOM_TTL_DAYS * 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        self.rooms = {name: room for name, room in self.rooms.items() if room.get("on") or str(room.get("updated_at") or "") >= cutoff}


PUBLIC_ROOM = ("room", "version", "on", "plate", "id", "updated_at")  # what the overlay gets without a login


def make_handler(service: Service, secure_cookie: bool = True):
    class Handler(BaseHTTPRequestHandler):
        server_version = "hoh-epl-onair"

        def log_message(self, fmt, *args):  # one short line per write, nothing per poll
            if self.command == "POST":
                sys.stderr.write(f"{now_iso()} {self.command} {urlparse(self.path).path} {fmt % args}\n")

        def reply(self, status: int, body: dict, headers: dict | None = None) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def token(self) -> str | None:
            jar = SimpleCookie()
            try:
                jar.load(self.headers.get("Cookie") or "")
            except Exception:  # noqa: BLE001 - a broken cookie header is just «not logged in»
                return None
            morsel = jar.get(COOKIE)
            return morsel.value if morsel else None

        def cookie(self, token: str | None) -> str:
            flags = "; Path=/; HttpOnly; SameSite=Lax" + ("; Secure" if secure_cookie else "")
            return f"{COOKIE}={token}; Max-Age={SESSION_DAYS * 86400}{flags}" if token else f"{COOKIE}=; Max-Age=0{flags}"

        def client_ip(self) -> str:
            return (self.headers.get("X-Forwarded-For") or self.client_address[0] or "").split(",")[0].strip()

        def room_name(self, value) -> str | None:
            name = str(value or "").strip().lower()
            return name if ROOM_RE.match(name) else None

        def do_GET(self):
            url = urlparse(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path == "/api/onair/state":
                name = self.room_name(query.get("room") or "1")
                if not name:
                    return self.reply(400, {"ok": False, "error": "bad_room"})
                room = service.room(name)
                return self.reply(200, {"ok": True, **{k: room.get(k) for k in PUBLIC_ROOM}})
            if url.path == "/api/onair/health":
                return self.reply(200, {"ok": True, "rooms": len(service.rooms)})
            user = service.session_user(self.token())
            if url.path == "/api/onair/auth":
                if user:
                    return self.reply(200, {"ok": True})
                wanted = self.headers.get("X-Forwarded-Uri") or "/"
                if wanted.startswith(("/data/", "/api/")):
                    return self.reply(401, {"ok": False, "error": "login_required"})
                target = urlparse(wanted).path or "/"
                return self.reply(302, {"ok": False, "error": "login_required"}, {"Location": f"/login.html?next={quote(target)}"})
            if not user:
                return self.reply(401, {"ok": False, "error": "login_required"})
            if url.path == "/api/onair/me":
                return self.reply(200, {"ok": True, "user": public_user(user), "mail": service.mailer.ready})
            if url.path == "/api/onair/rooms":
                return self.reply(200, {"ok": True, "rooms": sorted(service.rooms.values(), key=lambda r: r["room"])})
            if user["role"] != "admin":
                return self.reply(403 if url.path in ("/api/onair/users", "/api/onair/history") else 404, {"ok": False, "error": "admins_only"})
            if url.path == "/api/onair/users":
                with service.lock:
                    service.reload_users()
                    users = sorted(service.users.values(), key=lambda u: (u["role"] != "admin", not u.get("active"), u["name"]))
                    return self.reply(200, {"ok": True, "users": [public_user(u) for u in users], "mail": service.mailer.ready})
            if url.path == "/api/onair/history":
                try:
                    limit = max(1, min(HISTORY_ROWS, int(query.get("limit") or 300)))
                except ValueError:
                    limit = 300
                room = self.room_name(query.get("room")) if query.get("room") else None
                email = (query.get("email") or "").strip().lower() or None
                return self.reply(200, {"ok": True, "rows": service.history(room, email, limit)})
            return self.reply(404, {"ok": False, "error": "not_found"})

        def body(self) -> dict:
            if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
                raise ValueError("json_only")  # a cross-site form cannot send JSON: no request forgery with the cookie
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ValueError("too_large")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
            return body

        def do_POST(self):
            url = urlparse(self.path)
            try:
                body = self.body()
            except ValueError as problem:
                return self.reply(400, {"ok": False, "error": f"bad_request: {problem}"})
            if url.path == "/api/onair/login":
                token, user, error = service.login(body.get("email"), body.get("password"), self.client_ip())
                if error:
                    return self.reply(429 if error == "locked" else 403 if error == "no_access" else 401, {"ok": False, "error": error})
                return self.reply(200, {"ok": True, "user": public_user(user)}, {"Set-Cookie": self.cookie(token)})
            if url.path == "/api/onair/logout":
                service.logout(self.token())
                return self.reply(200, {"ok": True}, {"Set-Cookie": self.cookie(None)})
            token = self.token()
            user = service.session_user(token)
            if not user:
                return self.reply(401, {"ok": False, "error": "login_required"})
            if url.path == "/api/onair/password":
                error = service.change_password(user, body.get("old"), body.get("new"), token)
                return self.reply(400 if error else 200, {"ok": not error, **({"error": error} if error else {})})
            if url.path in ("/api/onair/show", "/api/onair/hide"):
                name = self.room_name(body.get("room"))
                if not name:
                    return self.reply(400, {"ok": False, "error": "bad_room"})
                if url.path.endswith("/show"):
                    try:
                        plate = clean_plate(body.get("plate"))
                    except (TypeError, ValueError) as problem:
                        return self.reply(400, {"ok": False, "error": f"bad_plate: {problem}"})
                    state = service.change(name, user, on=True, plate=plate, id=str(body.get("id") or "")[:TEXT_LIMIT] or None,
                                           match=str(body.get("match") or "")[:TEXT_LIMIT] or None)
                else:
                    state = service.change(name, user, on=False)
                return self.reply(200, {"ok": True, **state})
            if not url.path.startswith("/api/onair/users/"):
                return self.reply(404, {"ok": False, "error": "not_found"})
            if user["role"] != "admin":
                return self.reply(403, {"ok": False, "error": "admins_only"})
            try:
                if url.path == "/api/onair/users/add":
                    added, password = service.add_user(body.get("name"), body.get("email"), "commentator", user)
                    mailed = service.deliver(added, password, "invite")
                    return self.reply(200, {"ok": True, "user": public_user(added), "mailed": mailed, **({} if mailed else {"password": password})})
                if url.path == "/api/onair/users/access":
                    return self.reply(200, {"ok": True, "user": public_user(service.set_access(body.get("email"), bool(body.get("active")), user))})
                if url.path == "/api/onair/users/reset":
                    target, password = service.reset_password(body.get("email"), user)
                    mailed = service.deliver(target, password, "reset")
                    return self.reply(200, {"ok": True, "user": public_user(target), "mailed": mailed, **({} if mailed else {"password": password})})
            except ValueError as problem:
                return self.reply(400, {"ok": False, "error": str(problem)})
            return self.reply(404, {"ok": False, "error": "not_found"})

    return Handler


# ---------- the shell: accounts on the server (the first admins, invitations, a lost admin password) ----------
def own_state_files(state_dir: Path) -> None:
    """Run as root next to a DynamicUser service: hand the files back to the directory's owner."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        info = state_dir.stat()
        for path in state_dir.iterdir():
            os.chown(path, info.st_uid, info.st_gid)


def users_command(args, service: Service) -> int:
    if args.users_action == "list":
        for user in sorted(service.users.values(), key=lambda u: (u["role"] != "admin", u["name"])):
            print(f"{'+' if user.get('active') else '-'} {user['role']:<11} {user['name']:<28} {user['email']:<34} вход: {user.get('last_login') or 'не было'}")
        return 0
    if args.users_action == "invite":  # one line per person: Имя Фамилия;email;role
        failed = 0
        for raw in Path(args.file).read_text(encoding="utf-8").splitlines():
            if not raw.strip() or raw.startswith("#"):
                continue
            name, email, role = [part.strip() for part in raw.split(";")]
            try:
                user, password = service.add_user(name, email, role, None)
            except ValueError as problem:
                print(f"skip {email}: {problem}")
                continue
            if service.deliver(user, password, "invite"):
                print(f"ok   {email} ({role}): the password went by mail")
            else:
                failed += 1
                print(f"FAIL {email}: not mailed; send a new one later with `users reset {email}`")
            own_state_files(service.dir)
            time.sleep(args.pause)
        return 1 if failed else 0
    if args.users_action == "access":
        user = service.set_access(args.email, args.state == "on", None)
        own_state_files(service.dir)
        print(f"{user['email']}: {'доступ есть' if user['active'] else 'доступ забран'}")
        return 0
    if args.users_action == "reset":
        user, password = service.reset_password(args.email, None)
        own_state_files(service.dir)
        print(f"{user['email']}: " + ("the new password went by mail" if service.deliver(user, password, "reset") else "NOT mailed (no SMTP)"))
        return 0
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8096)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--state-dir", default=os.environ.get("STATE_DIRECTORY", "."))
    parser.add_argument("--smtp", default=os.path.join(os.environ.get("CREDENTIALS_DIRECTORY", "."), "smtp.env"))
    parser.add_argument("--insecure-cookie", action="store_true", help="local trials over plain http only")
    sub = parser.add_subparsers(dest="command")
    users = sub.add_parser("users", help="accounts from the server's shell")
    users_sub = users.add_subparsers(dest="users_action", required=True)
    users_sub.add_parser("list")
    invite = users_sub.add_parser("invite", help="create accounts and mail their passwords: a file of «Имя Фамилия;email;role»")
    invite.add_argument("file")
    invite.add_argument("--pause", type=float, default=20.0, help="seconds between letters")
    access = users_sub.add_parser("access")
    access.add_argument("email")
    access.add_argument("state", choices=("on", "off"))
    reset = users_sub.add_parser("reset")
    reset.add_argument("email")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    service = Service(Path(args.state_dir), Mailer(Path(args.smtp)))
    if args.command == "users":
        return users_command(args, service)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, secure_cookie=not args.insecure_cookie))
    sys.stderr.write(f"{now_iso()} on-air service on {args.host}:{args.port}, state {args.state_dir}, "
                     f"{len(service.users)} accounts, mail {'on' if service.mailer.ready else 'OFF'}\n")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
