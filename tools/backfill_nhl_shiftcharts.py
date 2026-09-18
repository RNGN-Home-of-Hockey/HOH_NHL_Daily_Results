#!/usr/bin/env python3
"""Collect NHL shift charts for the two HOH historical seasons.

Input game IDs are read from migrations/0017_nhl_two_season_games.sql so the
collector exactly follows the historical games already present in Data Core.

Output is compact:
- one row per player/game with shift count and TOI;
- aggregated shared-ice TOI for player pairs by season and across both seasons.

Raw shift rows are intentionally not persisted to D1.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import itertools
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

BASE = "https://api.nhle.com/stats/rest/en/shiftcharts"
UA = "HOH-NHL-Shiftcharts/1.0"
GAME_SQL = Path("migrations/0017_nhl_two_season_games.sql")
SEASONS = {"20242025", "20252026"}
GAME_RE = re.compile(
    r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',",
    re.M,
)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--games-sql", default=str(GAME_SQL))
    p.add_argument("--out", default="local-data/nhl-shiftcharts")
    p.add_argument("--workers", type=int, default=10)
    p.add_argument("--timeout", type=int, default=25)
    p.add_argument("--attempts", type=int, default=4)
    p.add_argument("--max-games", type=int, default=0)
    return p.parse_args()


def load_games(path: Path):
    text = path.read_text(encoding="utf-8")
    games = []
    for match in GAME_RE.finditer(text):
        game_pk, season_id, game_type, start_utc, home_tri, away_tri = match.groups()
        if season_id not in SEASONS:
            continue
        games.append(
            {
                "game_pk": int(game_pk),
                "season_id": season_id,
                "game_type": int(game_type),
                "start_utc": start_utc,
                "home_tri": home_tri,
                "away_tri": away_tri,
            }
        )
    games.sort(key=lambda row: (row["start_utc"], row["game_pk"]))
    return games


def fetch_json(url, timeout, attempts):
    last = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(
                url, headers={"Accept": "application/json", "User-Agent": UA}
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in {429, 500, 502, 503, 504}:
                raise
            if attempt < attempts:
                time.sleep(min(6.0, 0.5 * (2 ** (attempt - 1))))
    raise RuntimeError(str(last))


def seconds(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    parts = raw.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        return None
    return None


def team_tri(row):
    for key in ("teamAbbrev", "teamAbbrevs", "teamTriCode", "triCode"):
        value = row.get(key)
        if value:
            tri = str(value).strip().upper()
            if 2 < len(tri) < 5:
                return tri
    return None


def normalize_interval(row):
    try:
        period = int(row.get("period"))
        player_id = int(row.get("playerId"))
    except (TypeError, ValueError):
        return None
    tri = team_tri(row)
    if not tri:
        return None
    start = seconds(row.get("startTime"))
    end = seconds(row.get("endTime"))
    duration = seconds(row.get("duration"))
    if start is None and end is not None and duration is not None:
        start = max(0, end - duration)
    if end is None and start is not None and duration is not None:
        end = start + duration
    if start is None or end is None or end <= start:
        return None
    return {
        "period": period,
        "start": start,
        "end": end,
        "duration": duration if duration is not None else end - start,
        "player_id": player_id,
        "team_tri": tri,
    }


def merge_intervals(rows):
    by_period = defaultdict(list)
    for row in rows:
        by_period[row["period"]].append((row["start"], row["end"]))
    merged = {}
    for period, intervals in by_period.items():
        intervals.sort()
        out = []
        for start, end in intervals:
            if out and start <= out[-1][1]:
                out[-1] = (out[-1][0], max(out[-1][1], end))
            else:
                out.append((start, end))
        merged[period] = out
    return merged


def overlap_seconds(left, right):
    total = 0
    for period in set(left) & set(right):
        a = left[period]
        b = right[period]
        i = j = 0
        while i < len(a) and j < len(b):
            start = max(a[i][0], b[j][0])
            end = min(a[i][1], b[j][1])
            if end > start:
                total += end - start
            if a[i][1] <= b[j][1]:
                i += 1
            else:
                j += 1
    return total


def fetch_game(game, timeout, attempts):
    query = urllib.parse.urlencode({"cayenneExp": f"gameId={game['game_pk']}"})
    url = f"{BASE}?{query}"
    payload = fetch_json(url, timeout, attempts)
    data = payload.get("data") if isinstance(payload, dict) else None
    data = data if isinstance(data, list) else []
    intervals = []
    for raw in data:
        if not isinstance(raw, dict):
            continue
        row = normalize_interval(raw)
        if row:
            intervals.append(row)

    players = defaultdict(list)
    for row in intervals:
        players[(row["team_tri"], row["player_id"])].append(row)

    game_rows = []
    merged_by_player = {}
    for (tri, player_id), rows in players.items():
        merged = merge_intervals(rows)
        merged_by_player[(tri, player_id)] = merged
        toi = sum(end - start for values in merged.values() for start, end in values)
        first = min((period, start) for period, values in merged.items() for start, _ in values)
        last = max((period, end) for period, values in merged.items() for _, end in values)
        game_rows.append(
            {
                "game_pk": game["game_pk"],
                "season_id": game["season_id"],
                "team_tri": tri,
                "player_id": player_id,
                "shift_count": len(rows),
                "toi_seconds": toi,
                "first_period": first[0],
                "first_shift_second": first[1],
                "last_period": last[0],
                "last_shift_second": last[1],
                "source": "nhl_shiftcharts",
            }
        )

    pair_rows = []
    teams = sorted({tri for tri, _ in merged_by_player})
    for tri in teams:
        pids = sorted(pid for team, pid in merged_by_player if team == tri)
        for p1, p2 in itertools.combinations(pids, 2):
            shared = overlap_seconds(merged_by_player[(tri, p1)], merged_by_player[(tri, p2)])
            if shared <= 0:
                continue
            pair_rows.append(
                {
                    "game_pk": game["game_pk"],
                    "season_id": game["season_id"],
                    "start_utc": game["start_utc"],
                    "team_tri": tri,
                    "player1_id": p1,
                    "player2_id": p2,
                    "shared_toi_seconds": shared,
                }
            )

    return {
        "game": game,
        "raw_shifts": len(data),
        "valid_shifts": len(intervals),
        "player_rows": game_rows,
        "pair_rows": pair_rows,
        "url": url,
    }


def sql_quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def player_values(row, fetched_at):
    values = [
        row["game_pk"], row["season_id"], row["team_tri"], row["player_id"],
        row["shift_count"], row["toi_seconds"], row["first_period"],
        row["first_shift_second"], row["last_period"], row["last_shift_second"],
        row["source"], fetched_at,
    ]
    return "(" + ",".join(sql_quote(v) for v in values) + ")"


def pair_values(row):
    values = [
        row["scope_key"], row["team_tri"], row["player1_id"], row["player2_id"],
        row["games_together"], row["shared_toi_seconds"], row["shared_toi_seconds_pg"],
        row["last_game_pk"], row["last_game_utc"],
    ]
    return "(" + ",".join(sql_quote(v) for v in values) + ")"


def byte_bounded_statements(rows, header, tail, max_statement_bytes=60_000, max_rows=250):
    statements = []
    current = []
    size = len(header.encode("utf-8")) + len(tail.encode("utf-8"))
    for row in rows:
        row_size = len(row.encode("utf-8")) + 2
        if current and (len(current) >= max_rows or size + row_size > max_statement_bytes):
            statements.append(header + ",\n".join(current) + tail)
            current = []
            size = len(header.encode("utf-8")) + len(tail.encode("utf-8"))
        current.append(row)
        size += row_size
    if current:
        statements.append(header + ",\n".join(current) + tail)
    return statements


def write_sql(out_dir, player_rows, pair_rows, fetched_at):
    sql_dir = out_dir / "sql"
    sql_dir.mkdir(parents=True, exist_ok=True)
    for old in sql_dir.glob("*.sql"):
        old.unlink()

    player_header = """INSERT INTO nhl_player_shift_game (
  game_pk,season_id,team_tri,player_id,shift_count,toi_seconds,
  first_period,first_shift_second,last_period,last_shift_second,source,fetched_at
) VALUES
"""
    player_tail = """
ON CONFLICT(game_pk,player_id) DO UPDATE SET
  season_id=excluded.season_id,team_tri=excluded.team_tri,shift_count=excluded.shift_count,
  toi_seconds=excluded.toi_seconds,first_period=excluded.first_period,
  first_shift_second=excluded.first_shift_second,last_period=excluded.last_period,
  last_shift_second=excluded.last_shift_second,source=excluded.source,fetched_at=excluded.fetched_at;
"""
    pair_header = """INSERT INTO nhl_player_pair_toi (
  scope_key,team_tri,player1_id,player2_id,games_together,shared_toi_seconds,
  shared_toi_seconds_pg,last_game_pk,last_game_utc,computed_at
) VALUES
"""
    pair_tail = """
ON CONFLICT(scope_key,team_tri,player1_id,player2_id) DO UPDATE SET
  games_together=excluded.games_together,shared_toi_seconds=excluded.shared_toi_seconds,
  shared_toi_seconds_pg=excluded.shared_toi_seconds_pg,last_game_pk=excluded.last_game_pk,
  last_game_utc=excluded.last_game_utc,computed_at=CURRENT_TIMESTAMP;
"""

    statements = byte_bounded_statements(
        [player_values(row, fetched_at) for row in player_rows],
        player_header,
        player_tail,
    )
    statements += byte_bounded_statements(
        [pair_values(row) + "" for row in pair_rows],
        pair_header,
        pair_tail,
    )

    max_file_bytes = 2_000_000
    files = []
    parts = []
    used = 0
    for statement in statements:
        b = len(statement.encode("utf-8")) + 1
        if parts and used + b > max_file_bytes:
            path = sql_dir / f"shift_data_{len(files):03d}.sql"
            path.write_text("\n".join(parts), encoding="utf-8")
            files.append(path)
            parts = []
            used = 0
        parts.append(statement)
        used += b
    if parts:
        path = sql_dir / f"shift_data_{len(files):03d}.sql"
        path.write_text("\n".join(parts), encoding="utf-8")
        files.append(path)

    meta = f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('nhl_shiftcharts.player_game_rows','{len(player_rows)}',CURRENT_TIMESTAMP),
('nhl_shiftcharts.pair_rows','{len(pair_rows)}',CURRENT_TIMESTAMP),
('nhl_shiftcharts.seasons','20242025,20252026',CURRENT_TIMESTAMP),
('nhl_shiftcharts.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
"""
    (sql_dir / "shift_meta.sql").write_text(meta, encoding="utf-8")
    return files


def aggregate_pairs(pair_game_rows):
    agg = {}
    for row in pair_game_rows:
        scopes = ("2Y", f"S_{row['season_id']}")
        for scope in scopes:
            key = (scope, row["team_tri"], row["player1_id"], row["player2_id"])
            item = agg.get(key)
            if item is None:
                item = {
                    "scope_key": scope,
                    "team_tri": row["team_tri"],
                    "player1_id": row["player1_id"],
                    "player2_id": row["player2_id"],
                    "games": set(),
                    "shared_toi_seconds": 0,
                    "last_game_pk": row["game_pk"],
                    "last_game_utc": row["start_utc"],
                }
                agg[key] = item
            item["games"].add(row["game_pk"])
            item["shared_toi_seconds"] += row["shared_toi_seconds"]
            if row["start_utc"] > item["last_game_utc"]:
                item["last_game_utc"] = row["start_utc"]
                item["last_game_pk"] = row["game_pk"]

    output = []
    for item in agg.values():
        games = len(item.pop("games"))
        item["games_together"] = games
        item["shared_toi_seconds_pg"] = item["shared_toi_seconds"] / games if games else None
        output.append(item)
    output.sort(key=lambda row: (
        row["scope_key"], row["team_tri"], row["player1_id"], row["player2_id"]
    ))
    return output


def main():
    args = parse_args()
    games = load_games(Path(args.games_sql))
    if args.max_games > 0:
        games = games[: args.max_games]
    if not games:
        raise SystemExit("No historical games found")

    fetched_at = dt.datetime.now(dt.timezone.utc).isoformat()
    workers = max(1, min(args.workers, 16))
    print(f"SHIFTCHARTS games={len(games)} workers={workers}", flush=True)

    player_rows = []
    pair_game_rows = []
    failures = []
    raw_shifts = 0

    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(fetch_game, game, args.timeout, args.attempts): game
            for game in games
        }
        completed = 0
        for future in cf.as_completed(future_map):
            game = future_map[future]
            completed += 1
            try:
                result = future.result()
                raw_shifts += result["raw_shifts"]
                player_rows.extend(result["player_rows"])
                pair_game_rows.extend(result["pair_rows"])
            except Exception as exc:
                failures.append({"game_pk": game["game_pk"], "error": str(exc)})
            if completed % 100 == 0 or completed == len(games):
                print(
                    f"SHIFTCHARTS {completed}/{len(games)} player_rows={len(player_rows)} failures={len(failures)}",
                    flush=True,
                )

    player_rows.sort(key=lambda row: (row["game_pk"], row["team_tri"], row["player_id"]))
    pair_rows = aggregate_pairs(pair_game_rows)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    files = write_sql(out_dir, player_rows, pair_rows, fetched_at)

    summary = {
        "ok": bool(player_rows),
        "games_requested": len(games),
        "games_ok": len(games) - len(failures),
        "games_failed": len(failures),
        "raw_shift_rows": raw_shifts,
        "player_game_rows": len(player_rows),
        "pair_snapshot_rows": len(pair_rows),
        "sql_files": len(files),
        "fetched_at": fetched_at,
        "failures": failures,
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({k: v for k, v in summary.items() if k != "failures"}, ensure_ascii=False), flush=True)
    if not player_rows:
        raise SystemExit("No shiftchart data collected")


if __name__ == "__main__":
    main()
