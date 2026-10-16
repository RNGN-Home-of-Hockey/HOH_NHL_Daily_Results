#!/usr/bin/env python3
"""Checks for tools/epl_onair.py: a real server on a free local port, a temporary state file."""
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

KEY = "test-operator-key"
PLATE = {"headline": "Эвертон не проигрывает 6 матчей", "team": "Эвертон", "bet": "не проиграет", "odds": "3,00", "crests": [7], "crestWhole": False}


def call(base, path, body=None, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Operator-Key"] = key
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(base + path, data=data, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def serve(state_path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), onair.make_handler(onair.OnAir(state_path, KEY)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_show_hide_and_persistence():
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "onair.json"
        server, base = serve(state)
        try:
            assert call(base, "/api/onair/state?room=1")[1]["on"] is False
            assert call(base, "/api/onair/show", {"room": "1", "plate": PLATE})[0] == 401  # no key
            assert call(base, "/api/onair/show", {"room": "1", "plate": PLATE}, key="wrong")[0] == 401
            status, shown = call(base, "/api/onair/show", {"room": "1", "id": "card-1", "match": "Арсенал — Эвертон", "plate": PLATE}, key=KEY)
            assert status == 200 and shown["on"] and shown["version"] == 1 and shown["plate"]["odds"] == 3.0
            assert call(base, "/api/onair/state?room=1")[1]["plate"]["team"] == "Эвертон"
            assert call(base, "/api/onair/state?room=2")[1]["on"] is False  # channels are separate
            hidden = call(base, "/api/onair/hide", {"room": "1"}, key=KEY)[1]
            assert hidden["on"] is False and hidden["version"] == 2 and hidden["plate"]["team"] == "Эвертон"  # the plate stays for a re-show
            call(base, "/api/onair/show", {"room": "2", "plate": PLATE}, key=KEY)
            assert len(call(base, "/api/onair/off-all", {}, key=KEY)[1]["changed"]) == 1
            assert call(base, "/api/onair/check", key=KEY)[0] == 200
        finally:
            server.shutdown()
        again, base = serve(state)  # a restart keeps the state
        try:
            assert call(base, "/api/onair/state?room=1")[1]["version"] == 2
        finally:
            again.shutdown()


def test_bad_input_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        server, base = serve(Path(tmp) / "onair.json")
        try:
            assert call(base, "/api/onair/show", {"room": "../x", "plate": PLATE}, key=KEY)[0] == 400
            assert call(base, "/api/onair/show", {"room": "1", "plate": {"team": ""}}, key=KEY)[0] == 400
            assert call(base, "/api/onair/show", {"room": "1", "plate": {**PLATE, "odds": 0.5}}, key=KEY)[0] == 400
            assert call(base, "/api/onair/show", {"room": "1", "plate": {**PLATE, "crests": [1, 2, 3]}}, key=KEY)[0] == 400
        finally:
            server.shutdown()


def test_wrong_keys_lock_the_door():
    saved = onair.MAX_FAILURES
    onair.MAX_FAILURES = 3
    try:
        with tempfile.TemporaryDirectory() as tmp:
            server, base = serve(Path(tmp) / "onair.json")
            try:
                for _ in range(3):
                    assert call(base, "/api/onair/hide", {"room": "1"}, key="guess")[0] == 401
                assert call(base, "/api/onair/hide", {"room": "1"}, key=KEY)[0] == 429  # even the right key waits out the window
            finally:
                server.shutdown()
    finally:
        onair.MAX_FAILURES = saved


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
