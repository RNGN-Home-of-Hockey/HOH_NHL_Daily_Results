#!/usr/bin/env python3
"""Cover keeper for the HoH clip server.

The Live Center shows the cover of our VK broadcast on the match page. VK pictures for upcoming or finished broadcasts
are served through short-lived links and sometimes vanish, so this script keeps a small copy of every cover on this
server as soon as it appears:

  1. ask the Worker which games around today have a broadcast cover   (GET /api/telegram-center-v26/covers/wanted)
  2. download the picture the Worker already proxies from VK          (GET /api/telegram-center-media/vk-cover?source_key=...)
  3. shrink it to 640 px wide (ffmpeg) and save public_clips/covers/<game_pk>.jpg

The covers are public pictures that anybody can already see in the app. hoh_clip_index.py lists them in index.json and
Caddy serves /covers/<game_pk>.jpg. A cover is refreshed every 20 minutes while the game is not over (the picture can
change when the broadcast starts) and frozen once the game is final. Nothing is ever deleted here.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

WORKER = os.environ.get("HOH_WORKER", "https://hoh-nhl-daily-results.znamteam-903.workers.dev").rstrip("/")
OUT_DIR = os.environ.get("HOH_COVERS_DIR", "/opt/hoh-highlights/public_clips/covers")
FFMPEG = os.environ.get("HOH_FFMPEG", "/usr/bin/ffmpeg")
MAX_PER_RUN = 12
REFRESH_SECONDS = 20 * 60
MIN_SOURCE_BYTES = 3000
MAX_SOURCE_BYTES = 6 * 1024 * 1024
MIN_RESULT_BYTES = 1500
FINAL_STATES = {"OFF", "FINAL"}
KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,100}$")
UA = "HOH-Cover-Keeper/1"


def _get(url, timeout=25, limit=MAX_SOURCE_BYTES + 1):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower(), resp.read(limit)


def parse_wanted(payload):
    """Games worth a cover: [(game_pk, source_key, state)] from the Worker answer; anything odd is skipped."""
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return []
    out = []
    for row in payload.get("games") or []:
        if not isinstance(row, dict):
            continue
        pk, key = row.get("game_pk"), row.get("source_key")
        if isinstance(pk, bool) or not isinstance(pk, int) or not 10**7 <= pk < 10**12:
            continue
        if not isinstance(key, str) or not KEY_RE.match(key):
            continue
        out.append((pk, key, str(row.get("state") or "").upper()))
    return out


def needs_refresh(path, state, now=None):
    """Save when there is no cover yet; refresh while the game is on; leave it alone once the game is over."""
    try:
        age = (now if now is not None else time.time()) - os.stat(path).st_mtime
    except OSError:
        return True
    if state in FINAL_STATES:
        return False
    return age >= REFRESH_SECONDS


def looks_like_image(content_type, data):
    if not content_type.startswith("image/"):
        return False
    if not MIN_SOURCE_BYTES <= len(data) <= MAX_SOURCE_BYTES:
        return False
    return data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:4] == b"RIFF" or data[4:12] in (b"ftypavif", b"ftypheic")


def shrink(data, ffmpeg=FFMPEG):
    """640 px wide JPEG (about 30-60 KB) from whatever picture VK sent, or None."""
    with tempfile.TemporaryDirectory(prefix="hoh-cover-") as tmp:
        src, dst = os.path.join(tmp, "in.bin"), os.path.join(tmp, "out.jpg")
        with open(src, "wb") as fh:
            fh.write(data)
        cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", src, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", dst]
        try:
            subprocess.run(cmd, check=True, timeout=30, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
            with open(dst, "rb") as fh:
                jpeg = fh.read()
        except (OSError, subprocess.SubprocessError):
            return None
    return jpeg if len(jpeg) >= MIN_RESULT_BYTES and jpeg[:3] == b"\xff\xd8\xff" else None


def save(out_dir, game_pk, jpeg):
    os.makedirs(out_dir, exist_ok=True)
    final = os.path.join(out_dir, f"{game_pk}.jpg")
    fd, tmp = tempfile.mkstemp(prefix=".cover-", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(jpeg)
        os.chmod(tmp, 0o644)
        os.replace(tmp, final)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return final


def sync(fetch=_get, out_dir=OUT_DIR, shrinker=shrink, now=None):
    status, _, body = fetch(f"{WORKER}/api/telegram-center-v26/covers/wanted", 20, 2_000_000)
    if status != 200:
        return {"error": f"wanted_http_{status}", "saved": 0, "skipped": 0, "failed": 0}
    wanted = parse_wanted(json.loads(body.decode("utf-8")))
    saved = skipped = failed = 0
    for pk, key, state in wanted:
        path = os.path.join(out_dir, f"{pk}.jpg")
        if not needs_refresh(path, state, now):
            skipped += 1
            continue
        if saved + failed >= MAX_PER_RUN:
            break
        try:
            code, ctype, data = fetch(f"{WORKER}/api/telegram-center-media/vk-cover?source_key={urllib.parse.quote(key, safe='')}")
        except Exception:
            failed += 1
            continue
        if code != 200 or not looks_like_image(ctype, data):
            failed += 1
            continue
        jpeg = shrinker(data)
        if jpeg is None:
            failed += 1
            continue
        save(out_dir, pk, jpeg)
        saved += 1
    return {"saved": saved, "skipped": skipped, "failed": failed, "wanted": len(wanted)}


def main():
    try:
        result = sync()
    except Exception as error:  # the timer runs again in two minutes; never crash loudly on a network hiccup
        print(f"hoh_cover_sync: {type(error).__name__}: {error}")
        return 0
    print("hoh_cover_sync: " + ", ".join(f"{k}={v}" for k, v in result.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
