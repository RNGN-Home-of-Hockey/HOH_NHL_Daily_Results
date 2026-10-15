#!/usr/bin/env python3
"""Push the clip index and the covers of the highlights server to the HOH Worker on Cloudflare (2026-10-15).

Some Cloudflare data centres cannot reach this Moscow server (requests that came in through Frankfurt waited 8 s for
index.json and showed no goals), while this server reaches Cloudflare fine. So the server sends the two public files
to the Worker, which keeps the last copy for every data centre. Runs every 30 s from hoh-clip-push.timer; sends when a
file changed, and at least every 5 minutes (the Worker treats a copy older than 10 minutes as stale).
The Worker accepts the push only from this server's address. No secrets.
"""
import gzip
import hashlib
import json
import os
import sys
import time
import urllib.request

DIR = "/opt/hoh-highlights/public_clips"
URL = os.environ.get("HOH_PUSH_URL", "https://hoh-nhl-daily-results.rngn.workers.dev/api/telegram-center-v26/clip-index")
STATE = os.path.join(os.environ.get("STATE_DIRECTORY", "/var/lib/hoh-clip-push"), "last")
RESEND_SECONDS = 300


def read(name, default):
    try:
        with open(os.path.join(DIR, name), "rb") as f:
            data = f.read()
        json.loads(data)  # a file caught in the middle of a write is skipped this round
        return data
    except (OSError, ValueError):
        return default


def main():
    index = read("index.json", None)
    if index is None:
        return 0
    covers = read("covers.json", b"{}")
    digest = hashlib.sha256(index + b"\0" + covers).hexdigest()
    try:
        with open(STATE) as f:
            last = f.read().strip()
        age = time.time() - os.path.getmtime(STATE)
    except OSError:
        last, age = "", float("inf")
    if digest == last and age < RESEND_SECONDS:
        return 0
    body = gzip.compress(b'{"index":' + index + b',"covers":' + covers + b"}")
    request = urllib.request.Request(URL, data=body, method="POST", headers={
        "Content-Type": "application/json", "Content-Encoding": "gzip", "User-Agent": "hoh-clip-push/1",
    })
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            answer = json.loads(response.read() or b"{}")
    except Exception as error:  # the next run tries again in 30 s
        print(f"push failed: {error}", file=sys.stderr)
        return 1
    if not answer.get("ok"):
        print(f"push refused: {answer}", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w") as f:
        f.write(digest)
    os.replace(STATE + ".tmp", STATE)
    print(f"pushed {answer.get('games')} games, {len(body)} bytes gzip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
