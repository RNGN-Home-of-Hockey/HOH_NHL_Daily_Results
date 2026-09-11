#!/usr/bin/env python3
"""Build compact individual-market hit-rate snapshots from local player game logs.

Runs only against local-data/warehouse/hoh_history.sqlite after
build_compact_snapshots.py. No network or Cloudflare calls.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import sqlite3
from collections import defaultdict
from pathlib import Path

ROOT = Path.cwd()
WAREHOUSE = ROOT / "local-data" / "warehouse"
DB_PATH = WAREHOUSE / "hoh_history.sqlite"
CHUNK_ROOT = WAREHOUSE / "d1-chunks"
SUMMARY_PATH = WAREHOUSE / "player-market-snapshots-summary.json"
ROLLING_WINDOWS = (5, 10, 20)


def integer(value):
    if value is None or value == "":
        return 0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number):
        return 0
    return int(number)


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value) if math.isfinite(float(value)) else "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def aggregate(rows):
    games = len(rows)
    if not games:
        return None
    assists = sum(integer(r["assists"]) for r in rows)
    shots = sum(integer(r["shots"]) for r in rows)
    hits = sum(integer(r["hits"]) for r in rows)
    blocks = sum(integer(r["blocked_shots"]) for r in rows)
    return {
        "games": games,
        "games_with_assist": sum(1 for r in rows if integer(r["assists"]) >= 1),
        "games_with_2plus_shots": sum(1 for r in rows if integer(r["shots"]) >= 2),
        "games_with_3plus_shots": sum(1 for r in rows if integer(r["shots"]) >= 3),
        "games_with_4plus_shots": sum(1 for r in rows if integer(r["shots"]) >= 4),
        "games_with_5plus_shots": sum(1 for r in rows if integer(r["shots"]) >= 5),
        "games_with_2plus_hits": sum(1 for r in rows if integer(r["hits"]) >= 2),
        "games_with_3plus_hits": sum(1 for r in rows if integer(r["hits"]) >= 3),
        "games_with_2plus_blocks": sum(1 for r in rows if integer(r["blocked_shots"]) >= 2),
        "assists_pg": assists / games,
        "shots_pg": shots / games,
        "hits_pg": hits / games,
        "blocked_shots_pg": blocks / games,
    }


def build_rows(db, now_iso):
    required = {
        r[0]
        for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('player_game_features_local','player_rolling_snapshots_local','player_opponent_splits_local','players_compact_local')"
        )
    }
    expected = {"player_game_features_local", "player_rolling_snapshots_local", "player_opponent_splits_local", "players_compact_local"}
    missing = expected - required
    if missing:
        raise RuntimeError(f"compact player layer missing: {sorted(missing)}")

    game_rows = [dict(r) for r in db.execute(
        """
        SELECT game_pk,player_id,team_tri,opponent_tri,scheduled_start_utc,assists,shots,hits,blocked_shots
        FROM player_game_features_local
        ORDER BY player_id,scheduled_start_utc,game_pk
        """
    )]
    by_player = defaultdict(list)
    by_player_opponent = defaultdict(list)
    for row in game_rows:
        pid = int(row["player_id"])
        by_player[pid].append(row)
        by_player_opponent[(pid, str(row["opponent_tri"]))].append(row)

    team_by_player = {
        int(r["player_id"]): str(r["current_team_tri"] or "")
        for r in db.execute("SELECT player_id,current_team_tri FROM players_compact_local WHERE active=1")
        if r["current_team_tri"]
    }

    output = []
    rolling_source = [dict(r) for r in db.execute(
        """
        SELECT player_id,team_tri,window_key,as_of_utc,games
        FROM player_rolling_snapshots_local
        WHERE window_key IN ('5','10','20')
        ORDER BY player_id,CAST(window_key AS INTEGER)
        """
    )]
    for snap in rolling_source:
        pid = int(snap["player_id"])
        window = int(snap["window_key"])
        history = [r for r in by_player.get(pid, []) if str(r["scheduled_start_utc"]) <= str(snap["as_of_utc"])]
        sample = history[-window:]
        if len(sample) != window:
            continue
        agg = aggregate(sample)
        output.append(row_payload(
            pid=pid,
            team=str(snap["team_tri"] or team_by_player.get(pid, "")),
            snapshot_type="rolling",
            scope_key=str(window),
            opponent="",
            as_of=str(snap["as_of_utc"]),
            agg=agg,
            now_iso=now_iso,
        ))

    opponent_source = [dict(r) for r in db.execute(
        """
        SELECT player_id,team_tri,opponent_tri,scope_key,games,last_game_utc
        FROM player_opponent_splits_local
        WHERE scope_key='2Y' AND games>=4
        ORDER BY player_id,opponent_tri
        """
    )]
    for snap in opponent_source:
        pid = int(snap["player_id"])
        opponent = str(snap["opponent_tri"])
        sample = by_player_opponent.get((pid, opponent), [])
        if len(sample) < 4:
            continue
        agg = aggregate(sample)
        output.append(row_payload(
            pid=pid,
            team=str(snap["team_tri"] or team_by_player.get(pid, "")),
            snapshot_type="opponent",
            scope_key="2Y",
            opponent=opponent,
            as_of=str(snap["last_game_utc"] or sample[-1]["scheduled_start_utc"]),
            agg=agg,
            now_iso=now_iso,
        ))

    return output, {
        "local_player_game_rows": len(game_rows),
        "rolling_rows": sum(1 for r in output if r["snapshot_type"] == "rolling"),
        "opponent_rows": sum(1 for r in output if r["snapshot_type"] == "opponent"),
    }


def row_payload(*, pid, team, snapshot_type, scope_key, opponent, as_of, agg, now_iso):
    return {
        "player_id": pid,
        "team_tri": team,
        "snapshot_type": snapshot_type,
        "scope_key": scope_key,
        "opponent_tri": opponent,
        "as_of_utc": as_of,
        **agg,
        "computed_at": now_iso,
    }


def write_chunks(rows, batch=250):
    CHUNK_ROOT.mkdir(parents=True, exist_ok=True)
    for old in CHUNK_ROOT.glob("135_player_market_snapshots_*.sql"):
        old.unlink()
    if not rows:
        return 0
    cols = list(rows[0].keys())
    updates = [c for c in cols if c not in ("player_id", "snapshot_type", "scope_key", "opponent_tri")]
    chunks = 0
    for start in range(0, len(rows), batch):
        part = rows[start:start + batch]
        values = ",\n".join("(" + ",".join(sql_value(row[c]) for c in cols) + ")" for row in part)
        sql = (
            f"INSERT INTO player_market_snapshots ({','.join(cols)}) VALUES\n{values}\n"
            "ON CONFLICT(player_id,snapshot_type,scope_key,opponent_tri) DO UPDATE SET "
            + ",".join(f"{c}=excluded.{c}" for c in updates)
            + ";\n"
        )
        (CHUNK_ROOT / f"135_player_market_snapshots_{chunks:04d}.sql").write_text(sql, encoding="utf-8")
        chunks += 1
    return chunks


def main():
    if not DB_PATH.exists():
        raise SystemExit(f"Missing {DB_PATH}. Build local warehouse first.")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    rows, validation = build_rows(db, now_iso)
    chunks = write_chunks(rows)
    summary = {
        "ok": True,
        "created_at": now_iso,
        "rows": len(rows),
        "chunks": chunks,
        "validation": validation,
        "d1_writes_estimate": len(rows),
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    db.close()


if __name__ == "__main__":
    main()
