#!/usr/bin/env python3
"""Checks for tools/epl_onair.py: a real server on a free local port, a temporary state folder, made-up accounts."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_onair as onair  # noqa: E402

PLATE = {"headline": "Эвертон не проигрывает 6 матчей", "team": "Эвертон", "bet": "не проиграет", "odds": "3,00", "crests": [7], "crestWhole": False}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def call(base, path, body=None, cookie=None, headers=None, raw=False):
    """(status, json, session token from Set-Cookie or None, headers)."""
    sent = {"Content-Type": "application/json", **(headers or {})}
    if cookie:
        sent["Cookie"] = f"{onair.COOKIE}={cookie}"
    data = None if body is None else (body if raw else json.dumps(body).encode("utf-8"))
    request = urllib.request.Request(base + path, data=data, headers=sent, method="POST" if body is not None else "GET")
    try:
        with OPENER.open(request, timeout=10) as response:
            status, text, head = response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        status, text, head = error.code, error.read(), error.headers
    set_cookie = head.get("Set-Cookie") or ""
    token = set_cookie.split(";")[0].split("=", 1)[1] if set_cookie.startswith(onair.COOKIE + "=") else None
    return status, json.loads(text or b"{}"), token, head


def serve(folder):
    service = onair.Service(Path(folder))
    server = ThreadingHTTPServer(("127.0.0.1", 0), onair.make_handler(service, secure_cookie=False))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}", service


def accounts(service):
    _, admin_password = service.add_user("Павел Ботов", "Admin@Test.ru", "admin", None)
    _, password = service.add_user("Егор Пискунов", "egor@test.ru", "commentator", None)
    return admin_password, password


def login(base, email, password):
    status, body, token, _ = call(base, "/api/onair/login", {"email": email, "password": password})
    assert status == 200 and token, (status, body)
    return token


def test_only_a_login_opens_the_buttons():
    with tempfile.TemporaryDirectory() as tmp:
        server, base, service = serve(tmp)
        try:
            admin_password, password = accounts(service)
            assert call(base, "/api/onair/show", {"room": "1", "plate": PLATE})[0] == 401
            assert call(base, "/api/onair/rooms")[0] == 401
            assert call(base, "/api/onair/login", {"email": "egor@test.ru", "password": "wrong-one"})[0] == 401
            assert call(base, "/api/onair/login", {"email": "nobody@test.ru", "password": password})[0] == 401
            token = login(base, " EGOR@test.ru ", password)  # e-mail in any case, with spaces
            me = call(base, "/api/onair/me", cookie=token)[1]["user"]
            assert me["name"] == "Егор Пискунов" and me["role"] == "commentator" and "hash" not in me
            status, shown, _, _ = call(base, "/api/onair/show", {"room": "1", "id": "card-1", "match": "Арсенал — Эвертон", "plate": PLATE}, cookie=token)
            assert status == 200 and shown["on"] and shown["by"] == "Егор Пискунов" and shown["plate"]["odds"] == 3.0
            public = call(base, "/api/onair/state?room=1")[1]  # the overlay: no login, and no names
            assert public["plate"]["team"] == "Эвертон" and "by" not in public and "match" not in public
            assert call(base, "/api/onair/state?room=2")[1]["on"] is False  # matches are separate
            assert call(base, "/api/onair/hide", {"room": "1"}, cookie=token)[1]["on"] is False
            assert call(base, "/api/onair/off-all", {}, cookie=token)[0] == 404  # no «everything off»
            # a plain form post (not JSON) is refused even with the cookie: no request forgery from another site
            assert call(base, "/api/onair/show", b"room=1", cookie=token, headers={"Content-Type": "application/x-www-form-urlencoded"}, raw=True)[0] == 400
            # commentators do not manage people
            assert call(base, "/api/onair/users", cookie=token)[0] == 403
            assert call(base, "/api/onair/users/add", {"name": "Х Х", "email": "x@test.ru"}, cookie=token)[0] == 403
            assert call(base, "/api/onair/history", cookie=token)[0] == 403
            # logout ends the session
            call(base, "/api/onair/logout", {}, cookie=token)
            assert call(base, "/api/onair/me", cookie=token)[0] == 401
        finally:
            server.shutdown()


def test_the_site_is_closed_without_a_login():
    with tempfile.TemporaryDirectory() as tmp:
        server, base, service = serve(tmp)
        try:
            _, password = accounts(service)
            status, _, _, head = call(base, "/api/onair/auth", headers={"X-Forwarded-Uri": "/index.html?x=1"})
            assert status == 302 and head["Location"] == "/login.html?next=/index.html"
            assert call(base, "/api/onair/auth", headers={"X-Forwarded-Uri": "/data/site.json"})[0] == 401
            token = login(base, "egor@test.ru", password)
            assert call(base, "/api/onair/auth", cookie=token, headers={"X-Forwarded-Uri": "/data/site.json"})[0] == 200
        finally:
            server.shutdown()


def test_admins_give_and_take_access_and_everything_is_in_the_history():
    with tempfile.TemporaryDirectory() as tmp:
        server, base, service = serve(tmp)
        try:
            admin_password, password = accounts(service)
            admin = login(base, "admin@test.ru", admin_password)
            egor = login(base, "egor@test.ru", password)
            status, added, _, _ = call(base, "/api/onair/users/add", {"name": " Антон   Никитин ", "email": "Anton@Test.ru"}, cookie=admin)
            assert status == 200 and added["user"]["role"] == "commentator" and added["mailed"] is False and added["password"]  # no mail set up: shown once
            assert call(base, "/api/onair/users/add", {"name": "Антон Никитин", "email": "anton@test.ru"}, cookie=admin)[1]["error"] == "exists"
            assert call(base, "/api/onair/users/add", {"name": "А", "email": "not-an-email"}, cookie=admin)[0] == 400
            anton = login(base, "anton@test.ru", added["password"])
            # an admin cannot take an admin's access (their own included) — only a commentator's
            assert call(base, "/api/onair/users/access", {"email": "admin@test.ru", "active": False}, cookie=admin)[1]["error"] == "not_allowed"
            assert call(base, "/api/onair/users/access", {"email": "egor@test.ru", "active": False}, cookie=admin)[0] == 200
            assert call(base, "/api/onair/me", cookie=egor)[0] == 401  # his session is closed at once
            assert call(base, "/api/onair/login", {"email": "egor@test.ru", "password": password})[1]["error"] == "no_access"
            call(base, "/api/onair/users/access", {"email": "egor@test.ru", "active": True}, cookie=admin)
            login(base, "egor@test.ru", password)
            # a new password: the old one stops working
            reset = call(base, "/api/onair/users/reset", {"email": "anton@test.ru"}, cookie=admin)[1]
            assert call(base, "/api/onair/me", cookie=anton)[0] == 401
            assert call(base, "/api/onair/login", {"email": "anton@test.ru", "password": added["password"]})[0] == 401
            anton = login(base, "anton@test.ru", reset["password"])
            call(base, "/api/onair/show", {"room": "77", "id": "c", "match": "Ньюкасл — Астон Вилла", "plate": PLATE}, cookie=anton)
            call(base, "/api/onair/hide", {"room": "77"}, cookie=anton)
            people = call(base, "/api/onair/users", cookie=admin)[1]["users"]
            assert [u["email"] for u in people] == ["admin@test.ru", "anton@test.ru", "egor@test.ru"]  # admins first
            rows = call(base, "/api/onair/history?room=77", cookie=admin)[1]["rows"]
            assert [(r["action"], r["name"]) for r in rows] == [("hide", "Антон Никитин"), ("show", "Антон Никитин")]  # newest first
            assert rows[1]["plate"]["bet"] == "не проиграет" and rows[1]["match"] == "Ньюкасл — Астон Вилла"
            actions = [r["action"] for r in call(base, "/api/onair/history?email=egor@test.ru", cookie=admin)[1]["rows"]]
            assert "access_off" in actions and "access_on" in actions
        finally:
            server.shutdown()


def test_own_password_change():
    with tempfile.TemporaryDirectory() as tmp:
        server, base, service = serve(tmp)
        try:
            _, password = accounts(service)
            phone = login(base, "egor@test.ru", password)
            laptop = login(base, "egor@test.ru", password)
            assert call(base, "/api/onair/password", {"old": password, "new": "short"}, cookie=phone)[1]["error"] == "weak_password"
            assert call(base, "/api/onair/password", {"old": "wrong-old", "new": "new-pass-123"}, cookie=phone)[1]["error"] == "wrong_password"
            assert call(base, "/api/onair/password", {"old": password, "new": "new-pass-123"}, cookie=phone)[0] == 200
            assert call(base, "/api/onair/me", cookie=phone)[0] == 200  # this device stays in
            assert call(base, "/api/onair/me", cookie=laptop)[0] == 401  # the others are logged out
            login(base, "egor@test.ru", "new-pass-123")
        finally:
            server.shutdown()


def test_state_survives_a_restart_and_shell_changes_are_seen():
    with tempfile.TemporaryDirectory() as tmp:
        server, base, service = serve(tmp)
        try:
            _, password = accounts(service)
            token = login(base, "egor@test.ru", password)
            call(base, "/api/onair/show", {"room": "1", "plate": PLATE}, cookie=token)
        finally:
            server.shutdown()
        again, base, _ = serve(tmp)
        try:
            assert call(base, "/api/onair/state?room=1")[1]["on"] is True
            assert call(base, "/api/onair/me", cookie=token)[0] == 200  # the session too
            shell = onair.Service(Path(tmp))  # the owner takes the access from the server's shell
            shell.set_access("egor@test.ru", False, None)
            assert call(base, "/api/onair/me", cookie=token)[0] == 401  # the running service sees it
        finally:
            again.shutdown()


def test_old_matches_are_forgotten():
    with tempfile.TemporaryDirectory() as tmp:
        live = onair.Service(Path(tmp))
        live.rooms = {
            "100": {"room": "100", "on": False, "updated_at": "2020-01-01T00:00:00.000Z"},  # a past match: dropped
            "101": {"room": "101", "on": True, "updated_at": "2020-01-01T00:00:00.000Z"},   # still on air: kept
        }
        live.change("102", {"email": "a@test.ru", "name": "Тест"}, on=False)
        assert sorted(live.rooms) == ["101", "102"]


def test_bad_input_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        server, base, service = serve(tmp)
        try:
            _, password = accounts(service)
            token = login(base, "egor@test.ru", password)
            assert call(base, "/api/onair/show", {"room": "../x", "plate": PLATE}, cookie=token)[0] == 400
            assert call(base, "/api/onair/show", {"room": "1", "plate": {"team": ""}}, cookie=token)[0] == 400
            assert call(base, "/api/onair/show", {"room": "1", "plate": {**PLATE, "odds": 0.5}}, cookie=token)[0] == 400
            assert call(base, "/api/onair/show", {"room": "1", "plate": {**PLATE, "crests": [1, 2, 3]}}, cookie=token)[0] == 400
        finally:
            server.shutdown()


def test_wrong_passwords_lock_the_account():
    saved = onair.ACCOUNT_FAILURES
    onair.ACCOUNT_FAILURES = 3
    try:
        with tempfile.TemporaryDirectory() as tmp:
            server, base, service = serve(tmp)
            try:
                _, password = accounts(service)
                for _ in range(3):
                    assert call(base, "/api/onair/login", {"email": "egor@test.ru", "password": "guess"})[0] == 401
                assert call(base, "/api/onair/login", {"email": "egor@test.ru", "password": password})[0] == 429  # even the right one waits
                assert call(base, "/api/onair/login", {"email": "admin@test.ru", "password": "x"})[0] == 401  # other accounts are not locked
            finally:
                server.shutdown()
    finally:
        onair.ACCOUNT_FAILURES = saved


def test_passwords_and_letters():
    stored = onair.hash_password("secret-123")
    assert onair.check_password("secret-123", stored) and not onair.check_password("secret-124", stored)
    assert "secret" not in stored
    password = onair.new_password()
    assert len(password) == 11 and password[5] == "-" and not set(password.replace("-", "")) - set(onair.PASSWORD_ALPHABET)
    user = {"name": "Егор Пискунов", "email": "egor@test.ru", "role": "commentator"}
    subject, text = onair.letter(user, "abcde-fghjk", "invite")
    assert text.startswith("Егор, привет!") and "abcde-fghjk" in text and "egor@test.ru" in text and onair.SITE_URL in text
    assert "администратора" not in text and "администратора" in onair.letter({**user, "role": "admin"}, "x", "invite")[1]
    assert "—" not in text and "«" not in text  # the owner's letters: no long dashes, no quotes


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
