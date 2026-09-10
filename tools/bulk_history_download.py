#!/usr/bin/env python3
"""Download two NHL seasons to local disk with resume/checkpoint support.

Stdlib only. Safe to leave running unattended.

What it stores:
- schedule discovery cache by date
- per-game official NHL boxscore JSON
- per-game official NHL play-by-play JSON
- manifest JSONL
- progress/status JSON

It never writes to Cloudflare/D1 and never touches production.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
from pathlib import Path
import random
import threading
import time
import urllib.error
import urllib.request

NHL_BASE = "https://api-web.nhle.com/v1"
FINAL_STATES = {"FINAL", "OFF"}
ELIGIBLE_GAME_TYPES = {2, 3}
UA = "HOH-NHL-History-Builder/1.0"
PRINT_LOCK = threading.Lock()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--root", default="local-data/nhl-history")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--timeout", type=int, default=30)
    p.add_argument("--max-attempts", type=int, default=5)
    p.add_argument("--season", action="append", default=[])
    return p.parse_args()


def season_ranges(selected: list[str]) -> list[tuple[str, str, str]]:
    all_ranges = {
        "20242025": ("2024-10-01", "2025-06-30"),
        "20252026": ("2025-10-01", "2026-06-30"),
    }
    if not selected:
        selected = ["20242025", "20252026"]
    out = []
    for season in selected:
        if season not in all_ranges:
            raise SystemExit(f"Unsupported season {season}. Allowed: {', '.join(all_ranges)}")
        start, end = all_ranges[season]
        out.append((season, start, end))
    return out


def daterange(start: str, end: str):
    a = dt.date.fromisoformat(start)
    b = dt.date.fromisoformat(end)
    while a <= b:
        yield a.isoformat()
        a += dt.timedelta(days=1)


def request_json(url: str, timeout: int, max_attempts: int):
    last = None
    for attempt in range(1, max_attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code not in {429, 500, 502, 503, 504}:
                break
            if attempt < max_attempts:
                delay = min(8.0, 0.5 * (2 ** (attempt - 1))) + random.random() * 0.25
                time.sleep(delay)
    raise RuntimeError(f"Failed {url}: {last}")


def atomic_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def valid_json(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 20:
        return False
    try:
        json.loads(path.read_text(encoding="utf-8"))
        return True
    except Exception:
        return False


def games_for_date(payload: dict, date: str):
    direct = payload.get("games") if isinstance(payload.get("games"), list) else []
    week = []
    for entry in payload.get("gameWeek") or []:
        week.extend(entry.get("games") or [])
    source = direct or week
    out = []
    for game in source:
        game_date = str(game.get("gameDate") or "")
        if game_date and game_date != date:
            continue
        out.append(game)
    return out


def discover_games(root: Path, season: str, start: str, end: str, timeout: int, max_attempts: int):
    cache_dir = root / "schedule" / season
    games = {}
    dates = list(daterange(start, end))
    for i, date in enumerate(dates, 1):
        cache = cache_dir / f"{date}.json"
        if valid_json(cache):
            payload = json.loads(cache.read_text(encoding="utf-8"))
        else:
            payload = request_json(f"{NHL_BASE}/schedule/{date}", timeout, max_attempts)
            atomic_json(cache, payload)
        for game in games_for_date(payload, date):
            source_season = str(game.get("season") or "")
            game_type = int(game.get("gameType") or 0)
            state = str(game.get("gameState") or game.get("gameStatus") or "").upper()
            game_pk = game.get("id") or game.get("gameId") or game.get("gamePk")
            if source_season and source_season != season:
                continue
            if game_type not in ELIGIBLE_GAME_TYPES or state not in FINAL_STATES or not game_pk:
                continue
            games[int(game_pk)] = {
                "game_pk": int(game_pk),
                "season": season,
                "game_date": game.get("gameDate") or date,
                "start_time_utc": game.get("startTimeUTC"),
                "game_type": game_type,
                "state": state,
                "away": (game.get("awayTeam") or {}).get("abbrev"),
                "home": (game.get("homeTeam") or {}).get("abbrev"),
            }
        if i % 25 == 0 or i == len(dates):
            safe_print(f"DISCOVERY {season}: {i}/{len(dates)} dates, {len(games)} games")
    return [games[k] for k in sorted(games)]


def game_paths(root: Path, season: str, game_pk: int):
    d = root / "games" / season / str(game_pk)
    return d / "boxscore.json", d / "play-by-play.json"


def download_game(root: Path, meta: dict, timeout: int, max_attempts: int):
    game_pk = meta["game_pk"]
    season = meta["season"]
    box_path, pbp_path = game_paths(root, season, game_pk)
    cached_box = valid_json(box_path)
    cached_pbp = valid_json(pbp_path)
    if cached_box and cached_pbp:
        return {**meta, "status": "cached"}
    box = None if cached_box else request_json(f"{NHL_BASE}/gamecenter/{game_pk}/boxscore", timeout, max_attempts)
    pbp = None if cached_pbp else request_json(f"{NHL_BASE}/gamecenter/{game_pk}/play-by-play", timeout, max_attempts)
    if box is not None:
        if int(box.get("id") or 0) != game_pk:
            raise RuntimeError(f"Boxscore ID mismatch for {game_pk}")
        atomic_json(box_path, box)
    if pbp is not None:
        if int(pbp.get("id") or 0) != game_pk:
            raise RuntimeError(f"PBP ID mismatch for {game_pk}")
        atomic_json(pbp_path, pbp)
    return {**meta, "status": "downloaded"}


def safe_print(*args):
    with PRINT_LOCK:
        print(*args, flush=True)


def inventory_manual_csvs(project_root: Path, output_root: Path):
    src = project_root / "local-data" / "hockeystats" / "2025-26" / "teams"
    report = []
    if src.exists():
        import csv
        for path in sorted(src.glob("*.csv")):
            row = {"file": path.name, "bytes": path.stat().st_size, "columns": [], "rows": 0}
            try:
                with path.open("r", encoding="utf-8-sig", newline="") as f:
                    reader = csv.reader(f)
                    header = next(reader, [])
                    row["columns"] = header
                    row["rows"] = sum(1 for _ in reader)
            except Exception as e:
                row["error"] = str(e)
            report.append(row)
    atomic_json(output_root / "manual-csv-inventory.json", report)
    safe_print(f"MANUAL CSV: found {len(report)} files in {src}")


def main():
    args = parse_args()
    project_root = Path.cwd()
    root = (project_root / args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    inventory_manual_csvs(project_root, root)

    seasons = season_ranges(args.season)
    all_games = []
    for season, start, end in seasons:
        safe_print(f"Discovering {season} ({start}..{end})")
        all_games.extend(discover_games(root, season, start, end, args.timeout, args.max_attempts))

    manifest_path = root / "manifest.jsonl"
    status_path = root / "status.json"
    total = len(all_games)
    done = 0
    cached = 0
    failed = []
    started = time.time()

    safe_print(f"Found {total} eligible REG/playoff games. Downloading with {args.workers} workers...")
    with cf.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 12))) as ex:
        futures = {ex.submit(download_game, root, g, args.timeout, args.max_attempts): g for g in all_games}
        with manifest_path.open("a", encoding="utf-8") as manifest:
            for fut in cf.as_completed(futures):
                meta = futures[fut]
                try:
                    result = fut.result()
                    done += 1
                    cached += int(result["status"] == "cached")
                    manifest.write(json.dumps(result, ensure_ascii=False) + "\n")
                    manifest.flush()
                except Exception as e:
                    failed.append({**meta, "error": str(e)})
                    safe_print(f"FAILED {meta['game_pk']}: {e}")
                if (done + len(failed)) % 25 == 0 or done + len(failed) == total:
                    elapsed = max(time.time() - started, 1)
                    rate = (done + len(failed)) / elapsed
                    remaining = total - done - len(failed)
                    eta_min = remaining / rate / 60 if rate else 0
                    status = {
                        "total": total,
                        "completed": done,
                        "cached": cached,
                        "failed": len(failed),
                        "eta_minutes": round(eta_min, 1),
                        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    }
                    atomic_json(status_path, status)
                    safe_print(f"PROGRESS {done + len(failed)}/{total} | ok={done} cached={cached} failed={len(failed)} | ETA ~{eta_min:.1f} min")

    atomic_json(root / "failed.json", failed)
    complete = {
        "ok": not failed,
        "games": total,
        "completed": done,
        "cached": cached,
        "failed": len(failed),
        "root": str(root),
        "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    atomic_json(root / "complete.json", complete)
    safe_print("DONE", json.dumps(complete, ensure_ascii=False))
    if failed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
