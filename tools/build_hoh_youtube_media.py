#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import yt_dlp

CHANNEL = "https://www.youtube.com/@homeofhockey-yt"
NEWS_ID = "mjDYO1uaw7E"


def normalize_flat(info: dict, kind: str) -> dict | None:
    vid = str(info.get("id") or "").strip()
    if len(vid) != 11:
        return None
    title = str(info.get("title") or ("HOME OF HOCKEY NEWS" if kind == "news" else "HOME OF HOCKEY SHORTS")).strip()
    return {
        "id": vid,
        "kind": kind,
        "url": f"https://www.youtube.com/{'shorts/' if kind == 'short' else 'watch?v='}{vid}",
        "title": title,
        # YouTube's public image CDN is stable even when the video metadata endpoint
        # challenges GitHub-hosted runners with an anti-bot screen.
        "thumb": f"https://i.ytimg.com/vi/{vid}/hq720.jpg",
        "view_count": int(info.get("view_count") or 0),
    }


def extract_flat(url: str, playlistend: int = 50) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": True,
        "playlistend": playlistend,
        "socket_timeout": 20,
        "retries": 3,
        "extractor_retries": 3,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not isinstance(info, dict):
        raise RuntimeError(f"Unexpected yt-dlp payload for {url}")
    return info


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="state/hoh_youtube_media.json")
    args = ap.parse_args()

    shorts_info = extract_flat(CHANNEL + "/shorts?view=0&sort=p&flow=grid", 50)
    flat_entries = [x for x in (shorts_info.get("entries") or []) if isinstance(x, dict)]

    # The channel's Popular Shorts page is already ordered by YouTube. We deliberately
    # avoid per-video metadata requests here: GitHub Actions is frequently challenged by
    # YouTube's bot screen, while flat channel extraction remains available.
    shorts: list[dict] = []
    seen: set[str] = set()
    for raw in flat_entries:
        item = normalize_flat(raw, "short")
        if not item or item["id"] in seen:
            continue
        seen.add(item["id"])
        shorts.append(item)
        if len(shorts) >= 10:
            break
    if len(shorts) < 2:
        raise RuntimeError(f"Only {len(shorts)} Shorts found on {CHANNEL}")

    news = {
        "id": NEWS_ID,
        "kind": "news",
        "url": f"https://www.youtube.com/watch?v={NEWS_ID}",
        "title": "HOME OF HOCKEY NEWS",
        "thumb": f"https://i.ytimg.com/vi/{NEWS_ID}/hq720.jpg",
        "view_count": 0,
    }

    payload = {
        "channel": "@homeofhockey-yt",
        "news": news,
        "shorts_top10": shorts,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "out": str(out),
        "shorts": len(payload["shorts_top10"]),
        "short_ids": [x["id"] for x in payload["shorts_top10"]],
        "news": payload["news"]["id"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
