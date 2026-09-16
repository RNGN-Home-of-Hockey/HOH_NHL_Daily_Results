#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import yt_dlp

CHANNEL = "https://www.youtube.com/@homeofhockey-yt"
NEWS_ID = "mjDYO1uaw7E"


def thumb_for(info: dict, video_id: str) -> str:
    thumbs = info.get("thumbnails") or []
    for item in reversed(thumbs):
        url = str((item or {}).get("url") or "")
        if url:
            return url
    return f"https://i.ytimg.com/vi/{video_id}/hq720.jpg"


def normalize(info: dict, kind: str) -> dict | None:
    vid = str(info.get("id") or "").strip()
    if len(vid) != 11:
        return None
    title = str(info.get("title") or ("HOME OF HOCKEY NEWS" if kind == "news" else "HOME OF HOCKEY SHORTS")).strip()
    return {
        "id": vid,
        "kind": kind,
        "url": f"https://www.youtube.com/{'shorts/' if kind == 'short' else 'watch?v='}{vid}",
        "title": title,
        "thumb": thumb_for(info, vid),
        "view_count": int(info.get("view_count") or 0),
    }


def extract(ydl: yt_dlp.YoutubeDL, url: str) -> dict:
    info = ydl.extract_info(url, download=False)
    if not isinstance(info, dict):
        raise RuntimeError(f"Unexpected yt-dlp payload for {url}")
    return info


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="state/hoh_youtube_media.json")
    args = ap.parse_args()

    common = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 20,
        "retries": 3,
        "extractor_retries": 3,
    }
    with yt_dlp.YoutubeDL({**common, "extract_flat": True, "playlistend": 50}) as flat:
        shorts_info = extract(flat, CHANNEL + "/shorts?view=0&sort=p&flow=grid")
        flat_entries = [x for x in (shorts_info.get("entries") or []) if isinstance(x, dict)]

    # The popular Shorts tab is already ordered by YouTube. Enrich its first ten
    # entries individually so the cache contains stable titles/thumbnails/views.
    top_ids: list[str] = []
    for item in flat_entries:
        vid = str(item.get("id") or "").strip()
        if len(vid) == 11 and vid not in top_ids:
            top_ids.append(vid)
        if len(top_ids) >= 10:
            break
    if len(top_ids) < 2:
        raise RuntimeError(f"Only {len(top_ids)} Shorts found on {CHANNEL}")

    shorts: list[dict] = []
    with yt_dlp.YoutubeDL(common) as full:
        for vid in top_ids:
            try:
                item = normalize(extract(full, f"https://www.youtube.com/shorts/{vid}"), "short")
                if item:
                    shorts.append(item)
            except Exception as exc:
                print(f"short metadata failed {vid}: {exc}")
        news = normalize(extract(full, f"https://www.youtube.com/watch?v={NEWS_ID}"), "news")

    if len(shorts) < 2:
        # Flat metadata is still enough to render clickable screenshot cards.
        shorts = [normalize(x, "short") for x in flat_entries[:10]]
        shorts = [x for x in shorts if x]
    if len(shorts) < 2:
        raise RuntimeError("Need at least two cached Shorts")
    if not news:
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
        "shorts_top10": shorts[:10],
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
