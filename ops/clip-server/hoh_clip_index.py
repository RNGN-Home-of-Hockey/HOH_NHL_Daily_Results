#!/usr/bin/env python3
"""Public goals index for the HoH clip server.

The highlights engine writes one manifest.json per game next to the cut clips. This script publishes a small,
secret-free index.json that the Live Center Worker reads: which goals exist, who scored, and where the playable
files are. Only the whitelisted fields below are copied; capture sources, stream windows, scoreboard checks and
paths on disk never leave the server.

Layout it reads (read-only):  <tree>/<YYYYMMDD>/<away-home>/manifest.json
                              <tree>/<YYYYMMDD>/<away-home>/<clip>.mp4          original (1080p60)
                              <tree>/<YYYYMMDD>/<away-home>/tg/<clip>.mp4       light copy
                              <tree>/<YYYYMMDD>/<away-home>/_thumbs/<clip>.jpg  poster
Paths in the index are relative URLs under the clip server ("live/20261009/ana-wpg/<clip>.mp4").
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

TREES = (("vod", "/opt/hoh-highlights/clips_vod"), ("live", "/opt/hoh-highlights/clips_live"))
OUT = "/opt/hoh-highlights/public_clips/index.json"
COVERS_DIR = "/opt/hoh-highlights/public_clips/covers"
INDEX_VERSION = 1

DAY_RE = re.compile(r"^\d{8}$")
GAME_RE = re.compile(r"^[a-z0-9-]{3,24}$")
FILE_RE = re.compile(r"^[A-Za-z0-9._+-]{1,120}\.mp4$")
COVER_RE = re.compile(r"^(\d{8,12})\.jpg$")


def _safe_clip_name(name):
    if not isinstance(name, str) or not FILE_RE.match(name) or name.startswith(".") or ".." in name:
        return None
    return name


def _file_ref(game_dir, rel, url_prefix):
    path = os.path.join(game_dir, *rel.split("/"))
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not os.path.isfile(path) or st.st_size <= 0:
        return None
    return {"path": f"{url_prefix}/{rel}", "bytes": st.st_size}


def _pair(game_dir, name, url_prefix):
    """Original + light copy of one clip, or None when the original does not exist."""
    orig = _file_ref(game_dir, name, url_prefix)
    if orig is None:
        return None
    return {"orig": orig, "light": _file_ref(game_dir, "tg/" + name, url_prefix)}


def _goal_entry(game_dir, url_prefix, raw):
    if not isinstance(raw, dict) or raw.get("status") != "PASS":
        return None
    name = _safe_clip_name(raw.get("file"))
    if name is None:
        return None
    pair = _pair(game_dir, name, url_prefix)
    if pair is None:
        return None
    poster = _file_ref(game_dir, "_thumbs/" + name[:-4] + ".jpg", url_prefix)
    duration = raw.get("duration")
    return {
        "event_id": raw.get("event_id"),
        "period": raw.get("period"),
        "time_remaining": raw.get("time_remaining"),
        "away_score": raw.get("away_score"),
        "home_score": raw.get("home_score"),
        "scorer": raw.get("scorer"),
        "scorer_id": raw.get("scorer_id"),
        "team": raw.get("team"),
        "duration": round(float(duration), 1) if isinstance(duration, (int, float)) else None,
        "orig": pair["orig"],
        "light": pair["light"],
        "poster": poster["path"] if poster else None,
    }


def _extra_entry(game_dir, url_prefix, raw, with_kind=False):
    if not isinstance(raw, dict):
        return None
    name = _safe_clip_name(raw.get("file"))
    pair = _pair(game_dir, name, url_prefix) if name else None
    if pair is None:
        return None
    if with_kind:
        pair["kind"] = raw.get("kind") if isinstance(raw.get("kind"), str) else None
    return pair


def _event_key(goal):
    event_id = goal.get("event_id")
    return (0, event_id) if isinstance(event_id, int) else (1, 0)


def build_game(kind, day, game, game_dir):
    try:
        with open(os.path.join(game_dir, "manifest.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(manifest, dict):
        return None
    game_id = manifest.get("game_id")
    if isinstance(game_id, bool) or not isinstance(game_id, int):
        return None
    url_prefix = f"{kind}/{day}/{game}"
    goals = [g for g in (_goal_entry(game_dir, url_prefix, raw) for raw in (manifest.get("goals") or [])) if g]
    goals.sort(key=_event_key)
    all_goals = _extra_entry(game_dir, url_prefix, manifest.get("all_goals"))
    ending = _extra_entry(game_dir, url_prefix, manifest.get("ending"), with_kind=True)
    if not goals and not all_goals and not ending:
        return None
    return {
        "game_pk": game_id,
        "date": day,
        "kind": kind,
        "away": manifest.get("away"),
        "home": manifest.get("home"),
        "goals": goals,
        "all_goals": all_goals,
        "ending": ending,
    }


def build_covers(covers_dir=COVERS_DIR):
    """Small cover pictures of the VK broadcasts kept by hoh_cover_sync.py: {game_pk: {path, bytes, mtime}}."""
    covers = {}
    try:
        names = sorted(os.listdir(covers_dir))
    except OSError:
        return covers
    for name in names:
        m = COVER_RE.match(name)
        if not m:
            continue
        try:
            st = os.stat(os.path.join(covers_dir, name))
        except OSError:
            continue
        if st.st_size <= 0:
            continue
        covers[m.group(1)] = {"path": f"covers/{name}", "bytes": st.st_size, "mtime": int(st.st_mtime)}
    return covers


def build_index(trees=TREES, covers_dir=COVERS_DIR):
    games = []
    for kind, root in trees:
        try:
            days = sorted(d for d in os.listdir(root) if DAY_RE.match(d))
        except OSError:
            continue
        for day in days:
            day_dir = os.path.join(root, day)
            try:
                names = sorted(n for n in os.listdir(day_dir) if GAME_RE.match(n))
            except OSError:
                continue
            for game in names:
                game_dir = os.path.join(day_dir, game)
                if not os.path.isdir(game_dir):
                    continue
                entry = build_game(kind, day, game, game_dir)
                if entry:
                    games.append(entry)
    games.sort(key=lambda g: (g["date"], g["game_pk"]))
    return {
        "version": INDEX_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "games": games,
        "covers": build_covers(covers_dir),
    }


def _comparable(index):
    return {k: v for k, v in index.items() if k != "generated_at"}


def write_index(index, out_path=OUT):
    """Atomically replace out_path; returns False (and touches nothing) when the content did not change."""
    try:
        with open(out_path, encoding="utf-8") as fh:
            if _comparable(json.load(fh)) == _comparable(index):
                return False
    except (OSError, ValueError):
        pass
    out_dir = os.path.dirname(out_path)
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".index-", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))
        os.chmod(tmp, 0o644)
        os.replace(tmp, out_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return True


def main():
    index = build_index()
    changed = write_index(index)
    goals = sum(len(g["goals"]) for g in index["games"])
    print(f"hoh_clip_index: {len(index['games'])} games, {goals} goals, {'written' if changed else 'unchanged'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
