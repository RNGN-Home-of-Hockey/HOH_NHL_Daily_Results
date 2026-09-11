#!/usr/bin/env python3
"""Build low-read Stage 2 snapshots plus compact player/goalie aggregates.

This script works only against the local warehouse/raw archive. It does NOT call
Cloudflare or the NHL API.

Inputs:
- local-data/warehouse/hoh_history.sqlite
- local-data/nhl-history/games/<season>/<gamePk>/boxscore.json
- local-data/nhl-history/games/<season>/<gamePk>/play-by-play.json

Outputs:
- supplemental local tables inside hoh_history.sqlite
- local-data/warehouse/compact-snapshots-summary.json
- supplemental D1 chunks in local-data/warehouse/d1-chunks/

The D1 package intentionally exports aggregates/snapshots, not every historical
player-game row. Full player-game history stays in local SQLite so D1 Free reads
and writes remain small.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import sqlite3
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path.cwd()
WAREHOUSE = ROOT / "local-data" / "warehouse"
DB_PATH = WAREHOUSE / "hoh_history.sqlite"
CHUNK_ROOT = WAREHOUSE / "d1-chunks"
HISTORY_GAMES = ROOT / "local-data" / "nhl-history" / "games"
SUMMARY_PATH = WAREHOUSE / "compact-snapshots-summary.json"
WINDOWS = (5, 10, 20)


def text(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


def num(v):
    if v is None or v == "":
        return None
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def integer(v):
    x = num(v)
    if x is None:
        return None
    return int(x) if float(x).is_integer() else None


def localized(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return v.get("default") or v.get("en") or next((x for x in v.values() if isinstance(x, str)), None)
    return None


def toi_seconds(v):
    if not isinstance(v, str):
        return None
    m = re.match(r"^(\d+):(\d{2})$", v.strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def parse_save_shots(value):
    if not isinstance(value, str):
        return (None, None)
    m = re.match(r"^(\d+)/(\d+)$", value.strip())
    if not m:
        return (None, None)
    saves, shots = int(m.group(1)), int(m.group(2))
    return (saves, shots) if saves <= shots else (None, None)


def sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            return "NULL"
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def write_chunks(prefix, table, rows, conflict_cols, update_cols=None, batch=200):
    for old in CHUNK_ROOT.glob(f"{prefix}_*.sql"):
        old.unlink()
    rows = list(rows)
    if not rows:
        return 0, 0
    cols = list(rows[0].keys())
    if update_cols is None:
        update_cols = [c for c in cols if c not in conflict_cols]
    conflict = ",".join(conflict_cols)
    action = (
        "DO UPDATE SET " + ",".join(f"{c}=excluded.{c}" for c in update_cols)
        if update_cols
        else "DO NOTHING"
    )
    chunks = 0
    for start in range(0, len(rows), batch):
        part = rows[start : start + batch]
        values = ",\n".join("(" + ",".join(sql_value(row.get(c)) for c in cols) + ")" for row in part)
        path = CHUNK_ROOT / f"{prefix}_{chunks:04d}.sql"
        path.write_text(
            f"INSERT INTO {table} ({','.join(cols)}) VALUES\n{values}\nON CONFLICT({conflict}) {action};\n",
            encoding="utf-8",
        )
        chunks += 1
    return len(rows), chunks


def create_local_schema(db):
    db.executescript(
        """
        DROP TABLE IF EXISTS pregame_team_snapshots_local;
        DROP TABLE IF EXISTS players_compact_local;
        DROP TABLE IF EXISTS player_game_features_local;
        DROP TABLE IF EXISTS goalie_game_features_local;
        DROP TABLE IF EXISTS player_rolling_snapshots_local;
        DROP TABLE IF EXISTS player_opponent_splits_local;
        DROP TABLE IF EXISTS goalie_rolling_snapshots_local;
        DROP TABLE IF EXISTS goalie_opponent_splits_local;

        CREATE TABLE players_compact_local (
          player_id INTEGER PRIMARY KEY,
          first_name_en TEXT,
          last_name_en TEXT,
          full_name_en TEXT NOT NULL,
          current_team_tri TEXT,
          position_code TEXT,
          sweater_number INTEGER,
          shoots_catches TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          last_seen_game_start_utc TEXT,
          last_seen_game_pk INTEGER
        );

        CREATE TABLE player_game_features_local (
          game_pk INTEGER NOT NULL,
          player_id INTEGER NOT NULL,
          team_tri TEXT NOT NULL,
          opponent_tri TEXT NOT NULL,
          season_id TEXT NOT NULL,
          game_type INTEGER NOT NULL,
          scheduled_start_utc TEXT NOT NULL,
          is_home INTEGER NOT NULL,
          position_code TEXT,
          goals INTEGER NOT NULL,
          assists INTEGER NOT NULL,
          points INTEGER NOT NULL,
          shots INTEGER,
          hits INTEGER,
          blocked_shots INTEGER,
          pim INTEGER,
          plus_minus INTEGER,
          faceoff_pct REAL,
          toi_seconds INTEGER,
          power_play_goals INTEGER,
          PRIMARY KEY(game_pk, player_id)
        );
        CREATE INDEX idx_local_player_game_player_time
          ON player_game_features_local(player_id, scheduled_start_utc DESC);
        CREATE INDEX idx_local_player_game_opp
          ON player_game_features_local(player_id, opponent_tri, scheduled_start_utc DESC);

        CREATE TABLE goalie_game_features_local (
          game_pk INTEGER NOT NULL,
          player_id INTEGER NOT NULL,
          team_tri TEXT NOT NULL,
          opponent_tri TEXT NOT NULL,
          season_id TEXT NOT NULL,
          game_type INTEGER NOT NULL,
          scheduled_start_utc TEXT NOT NULL,
          is_home INTEGER NOT NULL,
          is_starter INTEGER,
          decision TEXT,
          saves INTEGER,
          shots_against INTEGER,
          goals_against INTEGER,
          save_pct REAL,
          toi_seconds INTEGER,
          even_strength_goals_against INTEGER,
          power_play_goals_against INTEGER,
          shorthanded_goals_against INTEGER,
          PRIMARY KEY(game_pk, player_id)
        );
        CREATE INDEX idx_local_goalie_game_player_time
          ON goalie_game_features_local(player_id, scheduled_start_utc DESC);
        CREATE INDEX idx_local_goalie_game_opp
          ON goalie_game_features_local(player_id, opponent_tri, scheduled_start_utc DESC);

        CREATE TABLE pregame_team_snapshots_local (
          game_pk INTEGER NOT NULL, team_tri TEXT NOT NULL, opponent_tri TEXT NOT NULL,
          window_games INTEGER NOT NULL, sample_size INTEGER NOT NULL, league_teams INTEGER,
          gf_pg REAL, ga_pg REAL, goal_diff_pg REAL, total_pg REAL, corsi_pct REAL,
          fenwick_pct REAL, p2_diff_pg REAL, rank_gf INTEGER, rank_ga INTEGER,
          rank_goal_diff INTEGER, rank_total INTEGER, rank_corsi INTEGER,
          rank_fenwick INTEGER, rank_p2_diff INTEGER,
          advanced_sample_size INTEGER, advanced_league_teams INTEGER,
          xgf_pct_5v5 REAL, xgf60_5v5 REAL, xga60_5v5 REAL, corsi_pct_5v5 REAL,
          fenwick_pct_5v5 REAL, pdo_5v5 REAL, gsax_5v5 REAL,
          rank_xgf_pct_5v5 INTEGER, rank_xgf60_5v5 INTEGER, rank_xga60_5v5 INTEGER,
          rank_corsi_pct_5v5 INTEGER, rank_fenwick_pct_5v5 INTEGER,
          computed_at TEXT NOT NULL,
          PRIMARY KEY(game_pk, team_tri, window_games)
        );

        CREATE TABLE player_rolling_snapshots_local (
          player_id INTEGER NOT NULL, team_tri TEXT NOT NULL, position_code TEXT,
          window_key TEXT NOT NULL, as_of_utc TEXT NOT NULL, games INTEGER NOT NULL,
          goals INTEGER NOT NULL, assists INTEGER NOT NULL, points INTEGER NOT NULL,
          shots INTEGER, hits INTEGER, blocked_shots INTEGER, pim INTEGER, plus_minus INTEGER,
          toi_seconds INTEGER, power_play_goals INTEGER, games_with_goal INTEGER NOT NULL,
          games_with_point INTEGER NOT NULL, games_with_2plus_points INTEGER NOT NULL,
          goals_pg REAL, assists_pg REAL, points_pg REAL, shots_pg REAL, toi_seconds_pg REAL,
          computed_at TEXT NOT NULL,
          PRIMARY KEY(player_id, window_key)
        );

        CREATE TABLE player_opponent_splits_local (
          player_id INTEGER NOT NULL, team_tri TEXT NOT NULL, opponent_tri TEXT NOT NULL,
          scope_key TEXT NOT NULL, games INTEGER NOT NULL, goals INTEGER NOT NULL,
          assists INTEGER NOT NULL, points INTEGER NOT NULL, shots INTEGER,
          games_with_goal INTEGER NOT NULL, games_with_point INTEGER NOT NULL,
          games_with_2plus_points INTEGER NOT NULL, goals_pg REAL, assists_pg REAL,
          points_pg REAL, shots_pg REAL, last_game_utc TEXT, computed_at TEXT NOT NULL,
          PRIMARY KEY(player_id, opponent_tri, scope_key)
        );

        CREATE TABLE goalie_rolling_snapshots_local (
          player_id INTEGER NOT NULL, team_tri TEXT NOT NULL, window_key TEXT NOT NULL,
          as_of_utc TEXT NOT NULL, games INTEGER NOT NULL, starts INTEGER NOT NULL,
          wins INTEGER NOT NULL, losses INTEGER NOT NULL, ot_losses INTEGER NOT NULL,
          saves INTEGER, shots_against INTEGER, goals_against INTEGER, save_pct REAL,
          goals_against_pg REAL, shutouts INTEGER NOT NULL, toi_seconds INTEGER,
          toi_seconds_pg REAL, computed_at TEXT NOT NULL,
          PRIMARY KEY(player_id, window_key)
        );

        CREATE TABLE goalie_opponent_splits_local (
          player_id INTEGER NOT NULL, team_tri TEXT NOT NULL, opponent_tri TEXT NOT NULL,
          scope_key TEXT NOT NULL, games INTEGER NOT NULL, starts INTEGER NOT NULL,
          wins INTEGER NOT NULL, losses INTEGER NOT NULL, ot_losses INTEGER NOT NULL,
          saves INTEGER, shots_against INTEGER, goals_against INTEGER, save_pct REAL,
          goals_against_pg REAL, shutouts INTEGER NOT NULL, last_game_utc TEXT,
          computed_at TEXT NOT NULL,
          PRIMARY KEY(player_id, opponent_tri, scope_key)
        );
        """
    )
    db.commit()


def update_player(db, meta, game):
    player_id = integer(meta.get("playerId"))
    if player_id is None:
        return
    first = localized(meta.get("firstName"))
    last = localized(meta.get("lastName"))
    full = " ".join(x for x in (first, last) if x) or f"NHL {player_id}"
    db.execute(
        """
        INSERT INTO players_compact_local(
          player_id,first_name_en,last_name_en,full_name_en,current_team_tri,position_code,
          sweater_number,shoots_catches,active,last_seen_game_start_utc,last_seen_game_pk
        ) VALUES(?,?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT(player_id) DO UPDATE SET
          first_name_en=COALESCE(excluded.first_name_en,players_compact_local.first_name_en),
          last_name_en=COALESCE(excluded.last_name_en,players_compact_local.last_name_en),
          full_name_en=excluded.full_name_en,
          current_team_tri=CASE WHEN excluded.last_seen_game_start_utc>=COALESCE(players_compact_local.last_seen_game_start_utc,'') THEN excluded.current_team_tri ELSE players_compact_local.current_team_tri END,
          position_code=CASE WHEN excluded.last_seen_game_start_utc>=COALESCE(players_compact_local.last_seen_game_start_utc,'') THEN COALESCE(excluded.position_code,players_compact_local.position_code) ELSE players_compact_local.position_code END,
          sweater_number=CASE WHEN excluded.last_seen_game_start_utc>=COALESCE(players_compact_local.last_seen_game_start_utc,'') THEN COALESCE(excluded.sweater_number,players_compact_local.sweater_number) ELSE players_compact_local.sweater_number END,
          last_seen_game_start_utc=MAX(COALESCE(players_compact_local.last_seen_game_start_utc,''),excluded.last_seen_game_start_utc),
          last_seen_game_pk=CASE WHEN excluded.last_seen_game_start_utc>=COALESCE(players_compact_local.last_seen_game_start_utc,'') THEN excluded.last_seen_game_pk ELSE players_compact_local.last_seen_game_pk END
        """,
        (
            player_id,
            first,
            last,
            full,
            meta.get("team_tri"),
            text(meta.get("positionCode")),
            integer(meta.get("sweaterNumber")),
            None,
            game["scheduled_start_utc"],
            game["game_pk"],
        ),
    )


def load_player_game_history(db):
    games = {
        int(r["game_pk"]): dict(r)
        for r in db.execute(
            "SELECT game_pk,season_id,game_type,scheduled_start_utc,home_tri,away_tri FROM games WHERE game_type IN (2,3)"
        )
    }
    parsed_games = 0
    missing_raw = []
    for season_dir in sorted(HISTORY_GAMES.glob("20*")):
        for game_dir in sorted(season_dir.iterdir()):
            if not game_dir.is_dir() or not game_dir.name.isdigit():
                continue
            game_pk = int(game_dir.name)
            game = games.get(game_pk)
            if not game:
                continue
            box_path = game_dir / "boxscore.json"
            pbp_path = game_dir / "play-by-play.json"
            if not box_path.exists() or not pbp_path.exists():
                missing_raw.append(game_pk)
                continue
            box = json.loads(box_path.read_text(encoding="utf-8"))
            pbp = json.loads(pbp_path.read_text(encoding="utf-8"))
            team_by_id = {
                integer(box.get("homeTeam", {}).get("id")): game["home_tri"],
                integer(box.get("awayTeam", {}).get("id")): game["away_tri"],
            }
            roster = {}
            for spot in pbp.get("rosterSpots") or []:
                pid = integer(spot.get("playerId"))
                tri = team_by_id.get(integer(spot.get("teamId")))
                if pid is None or not tri:
                    continue
                meta = dict(spot)
                meta["team_tri"] = tri
                roster[pid] = meta
                update_player(db, meta, game)

            for side, is_home in (("awayTeam", 0), ("homeTeam", 1)):
                team_tri = game["home_tri"] if is_home else game["away_tri"]
                opponent = game["away_tri"] if is_home else game["home_tri"]
                for group in ("forwards", "defense"):
                    for source in ((box.get("playerByGameStats") or {}).get(side) or {}).get(group) or []:
                        pid = integer(source.get("playerId"))
                        if pid is None:
                            continue
                        meta = roster.get(pid) or {"playerId": pid, "team_tri": team_tri, "positionCode": "D" if group == "defense" else None}
                        update_player(db, meta, game)
                        goals = integer(source.get("goals")) or 0
                        assists = integer(source.get("assists")) or 0
                        points = integer(source.get("points"))
                        if points is None:
                            points = goals + assists
                        db.execute(
                            """
                            INSERT OR REPLACE INTO player_game_features_local(
                              game_pk,player_id,team_tri,opponent_tri,season_id,game_type,scheduled_start_utc,is_home,
                              position_code,goals,assists,points,shots,hits,blocked_shots,pim,plus_minus,
                              faceoff_pct,toi_seconds,power_play_goals
                            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                            """,
                            (
                                game_pk,pid,team_tri,opponent,game["season_id"],game["game_type"],game["scheduled_start_utc"],is_home,
                                text(meta.get("positionCode")),goals,assists,points,integer(source.get("sog")),integer(source.get("hits")),
                                integer(source.get("blockedShots")),integer(source.get("pim")),integer(source.get("plusMinus")),
                                num(source.get("faceoffWinningPctg")),toi_seconds(source.get("toi")),integer(source.get("powerPlayGoals")),
                            ),
                        )

                for source in ((box.get("playerByGameStats") or {}).get(side) or {}).get("goalies") or []:
                    pid = integer(source.get("playerId"))
                    if pid is None:
                        continue
                    meta = roster.get(pid) or {"playerId": pid, "team_tri": team_tri, "positionCode": "G"}
                    update_player(db, meta, game)
                    parsed_saves, parsed_shots = parse_save_shots(source.get("saveShotsAgainst"))
                    saves = integer(source.get("saves"))
                    shots = integer(source.get("shotsAgainst"))
                    saves = saves if saves is not None else parsed_saves
                    shots = shots if shots is not None else parsed_shots
                    save_pct = num(source.get("savePctg"))
                    if save_pct is None and saves is not None and shots:
                        save_pct = saves / shots
                    db.execute(
                        """
                        INSERT OR REPLACE INTO goalie_game_features_local(
                          game_pk,player_id,team_tri,opponent_tri,season_id,game_type,scheduled_start_utc,is_home,
                          is_starter,decision,saves,shots_against,goals_against,save_pct,toi_seconds,
                          even_strength_goals_against,power_play_goals_against,shorthanded_goals_against
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            game_pk,pid,team_tri,opponent,game["season_id"],game["game_type"],game["scheduled_start_utc"],is_home,
                            int(source.get("starter")) if isinstance(source.get("starter"), bool) else None,
                            text(source.get("decision")),saves,shots,integer(source.get("goalsAgainst")),save_pct,
                            toi_seconds(source.get("toi")),integer(source.get("evenStrengthGoalsAgainst")),
                            integer(source.get("powerPlayGoalsAgainst")),integer(source.get("shorthandedGoalsAgainst")),
                        ),
                    )
            parsed_games += 1
            if parsed_games % 250 == 0:
                print(f"PLAYERS: parsed {parsed_games} games", flush=True)
    db.commit()
    return {"parsed_games": parsed_games, "missing_raw": missing_raw}


def avg(rows, key):
    vals = [num(r.get(key)) for r in rows]
    vals = [v for v in vals if v is not None]
    return sum(vals) / len(vals) if vals else None


def sum_int(rows, key):
    vals = [integer(r.get(key)) for r in rows]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None


def aggregate_skater(rows):
    games = len(rows)
    goals = sum(integer(r.get("goals")) or 0 for r in rows)
    assists = sum(integer(r.get("assists")) or 0 for r in rows)
    points = sum(integer(r.get("points")) or 0 for r in rows)
    shots = sum_int(rows, "shots")
    toi = sum_int(rows, "toi_seconds")
    return {
        "games": games,
        "goals": goals,
        "assists": assists,
        "points": points,
        "shots": shots,
        "hits": sum_int(rows, "hits"),
        "blocked_shots": sum_int(rows, "blocked_shots"),
        "pim": sum_int(rows, "pim"),
        "plus_minus": sum_int(rows, "plus_minus"),
        "toi_seconds": toi,
        "power_play_goals": sum_int(rows, "power_play_goals"),
        "games_with_goal": sum(1 for r in rows if (integer(r.get("goals")) or 0) >= 1),
        "games_with_point": sum(1 for r in rows if (integer(r.get("points")) or 0) >= 1),
        "games_with_2plus_points": sum(1 for r in rows if (integer(r.get("points")) or 0) >= 2),
        "goals_pg": goals / games if games else None,
        "assists_pg": assists / games if games else None,
        "points_pg": points / games if games else None,
        "shots_pg": shots / games if games and shots is not None else None,
        "toi_seconds_pg": toi / games if games and toi is not None else None,
    }


def aggregate_goalie(rows):
    games = len(rows)
    saves = sum_int(rows, "saves")
    shots = sum_int(rows, "shots_against")
    ga = sum_int(rows, "goals_against")
    toi = sum_int(rows, "toi_seconds")
    decisions = [str(r.get("decision") or "").upper() for r in rows]
    starts = sum(1 for r in rows if integer(r.get("is_starter")) == 1)
    return {
        "games": games,
        "starts": starts,
        "wins": sum(1 for d in decisions if d == "W"),
        "losses": sum(1 for d in decisions if d == "L"),
        "ot_losses": sum(1 for d in decisions if d in ("O", "OT", "OTL")),
        "saves": saves,
        "shots_against": shots,
        "goals_against": ga,
        "save_pct": saves / shots if saves is not None and shots else None,
        "goals_against_pg": ga / games if ga is not None and games else None,
        "shutouts": sum(1 for r in rows if (integer(r.get("goals_against")) or 0) == 0 and (integer(r.get("toi_seconds")) or 0) >= 3000),
        "toi_seconds": toi,
        "toi_seconds_pg": toi / games if toi is not None and games else None,
    }


def build_player_aggregates(db, now_iso):
    latest_season = str(db.execute("SELECT MAX(season_id) FROM games WHERE game_type IN (2,3)").fetchone()[0])
    skater_rows = [dict(r) for r in db.execute("SELECT * FROM player_game_features_local ORDER BY player_id,scheduled_start_utc,game_pk")]
    goalie_rows = [dict(r) for r in db.execute("SELECT * FROM goalie_game_features_local ORDER BY player_id,scheduled_start_utc,game_pk")]

    skaters = defaultdict(list)
    goalies = defaultdict(list)
    for r in skater_rows:
        skaters[int(r["player_id"])].append(r)
    for r in goalie_rows:
        goalies[int(r["player_id"])].append(r)

    active_skaters = {pid for pid, rows in skaters.items() if str(rows[-1]["season_id"]) == latest_season}
    active_goalies = {pid for pid, rows in goalies.items() if str(rows[-1]["season_id"]) == latest_season}

    for pid in sorted(active_skaters):
        rows = skaters[pid]
        latest = rows[-1]
        variants = []
        for w in WINDOWS:
            if len(rows) >= w:
                variants.append((str(w), rows[-w:]))
        season_rows = [r for r in rows if str(r["season_id"]) == latest_season]
        if season_rows:
            variants.append((latest_season, season_rows))
        variants.append(("2Y", rows))
        for key, sample in variants:
            a = aggregate_skater(sample)
            db.execute(
                """INSERT OR REPLACE INTO player_rolling_snapshots_local VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    pid,latest["team_tri"],latest["position_code"],key,latest["scheduled_start_utc"],a["games"],a["goals"],a["assists"],a["points"],
                    a["shots"],a["hits"],a["blocked_shots"],a["pim"],a["plus_minus"],a["toi_seconds"],a["power_play_goals"],
                    a["games_with_goal"],a["games_with_point"],a["games_with_2plus_points"],a["goals_pg"],a["assists_pg"],a["points_pg"],
                    a["shots_pg"],a["toi_seconds_pg"],now_iso,
                ),
            )
        for scope, scoped in (("2Y", rows), (latest_season, season_rows)):
            groups = defaultdict(list)
            for r in scoped:
                groups[r["opponent_tri"]].append(r)
            for opp, sample in groups.items():
                if len(sample) < 2:
                    continue
                a = aggregate_skater(sample)
                db.execute(
                    """INSERT OR REPLACE INTO player_opponent_splits_local VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        pid,latest["team_tri"],opp,scope,a["games"],a["goals"],a["assists"],a["points"],a["shots"],a["games_with_goal"],
                        a["games_with_point"],a["games_with_2plus_points"],a["goals_pg"],a["assists_pg"],a["points_pg"],a["shots_pg"],
                        sample[-1]["scheduled_start_utc"],now_iso,
                    ),
                )

    for pid in sorted(active_goalies):
        rows = goalies[pid]
        latest = rows[-1]
        variants = []
        for w in WINDOWS:
            if len(rows) >= w:
                variants.append((str(w), rows[-w:]))
        season_rows = [r for r in rows if str(r["season_id"]) == latest_season]
        if season_rows:
            variants.append((latest_season, season_rows))
        variants.append(("2Y", rows))
        for key, sample in variants:
            a = aggregate_goalie(sample)
            db.execute(
                """INSERT OR REPLACE INTO goalie_rolling_snapshots_local VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    pid,latest["team_tri"],key,latest["scheduled_start_utc"],a["games"],a["starts"],a["wins"],a["losses"],a["ot_losses"],
                    a["saves"],a["shots_against"],a["goals_against"],a["save_pct"],a["goals_against_pg"],a["shutouts"],a["toi_seconds"],
                    a["toi_seconds_pg"],now_iso,
                ),
            )
        for scope, scoped in (("2Y", rows), (latest_season, season_rows)):
            groups = defaultdict(list)
            for r in scoped:
                groups[r["opponent_tri"]].append(r)
            for opp, sample in groups.items():
                if len(sample) < 2:
                    continue
                a = aggregate_goalie(sample)
                db.execute(
                    """INSERT OR REPLACE INTO goalie_opponent_splits_local VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        pid,latest["team_tri"],opp,scope,a["games"],a["starts"],a["wins"],a["losses"],a["ot_losses"],a["saves"],a["shots_against"],
                        a["goals_against"],a["save_pct"],a["goals_against_pg"],a["shutouts"],sample[-1]["scheduled_start_utc"],now_iso,
                    ),
                )
    db.commit()
    return {"latest_season": latest_season, "active_skaters": len(active_skaters), "active_goalies": len(active_goalies)}


def valid_average(rows, key, minimum_fraction=0.8):
    vals = [num(r.get(key)) for r in rows]
    vals = [v for v in vals if v is not None]
    if len(vals) < math.ceil(len(rows) * minimum_fraction):
        return None
    return sum(vals) / len(vals)


def base_summary(rows):
    return {
        "gf": avg(rows, "final_goals_for"),
        "ga": avg(rows, "final_goals_against"),
        "goal_diff": avg(rows, "final_goal_diff"),
        "total": avg(rows, "total_goals"),
        "corsi": valid_average(rows, "corsi_for_pct"),
        "fenwick": valid_average(rows, "fenwick_for_pct"),
        "p2_diff": sum((integer(r.get("p2_goals_for")) or 0) - (integer(r.get("p2_goals_against")) or 0) for r in rows) / len(rows),
    }


def advanced_summary(rows):
    valid_toi = [r for r in rows if (num(r.get("toi_5v5_minutes")) or 0) > 0]
    if len(valid_toi) < math.ceil(len(rows) * 0.8):
        return None
    toi = sum(num(r.get("toi_5v5_minutes")) or 0 for r in valid_toi)
    xgf = sum(num(r.get("xgf_5v5")) or 0 for r in valid_toi)
    xga = sum(num(r.get("xga_5v5")) or 0 for r in valid_toi)
    return {
        "xgf_pct": valid_average(rows, "xgf_pct_5v5"),
        "xgf60": 60 * xgf / toi if toi else None,
        "xga60": 60 * xga / toi if toi else None,
        "corsi": valid_average(rows, "corsi_for_pct_5v5"),
        "fenwick": valid_average(rows, "fenwick_for_pct_5v5"),
        "pdo": valid_average(rows, "pdo_5v5", 0.5),
        "gsax": valid_average(rows, "goals_saved_above_expected", 0.5),
    }


def ranks(summaries, key, ascending=False):
    vals = [(team, s.get(key)) for team, s in summaries.items() if s.get(key) is not None and math.isfinite(float(s.get(key)))]
    vals.sort(key=lambda x: (x[1], x[0]) if ascending else (-x[1], x[0]))
    return {team: i + 1 for i, (team, _) in enumerate(vals, 1)}


def build_team_snapshots(db, now_iso):
    games = [dict(r) for r in db.execute("SELECT game_pk,scheduled_start_utc,home_tri,away_tri FROM games WHERE game_type IN (2,3) ORDER BY scheduled_start_utc,game_pk")]
    features = defaultdict(dict)
    for r in db.execute("SELECT * FROM team_game_features ORDER BY scheduled_start_utc,game_pk,team_tri"):
        features[int(r["game_pk"])][r["team_tri"]] = dict(r)
    advanced = defaultdict(dict)
    for r in db.execute("SELECT * FROM team_game_advanced_features ORDER BY game_pk,team_tri"):
        advanced[int(r["game_pk"])][r["team_tri"]] = dict(r)

    base_hist = defaultdict(lambda: deque(maxlen=20))
    adv_hist = defaultdict(lambda: deque(maxlen=20))
    by_time = defaultdict(list)
    for g in games:
        by_time[g["scheduled_start_utc"]].append(g)

    inserted = 0
    for idx, (start, group) in enumerate(sorted(by_time.items()), 1):
        snapshot_by_window = {}
        for window in WINDOWS:
            base_summaries = {
                team: base_summary(list(hist)[-window:])
                for team, hist in base_hist.items()
                if len(hist) >= window
            }
            adv_summaries = {
                team: advanced_summary(list(hist)[-window:])
                for team, hist in adv_hist.items()
                if len(hist) >= window
            }
            adv_summaries = {k: v for k, v in adv_summaries.items() if v is not None}
            base_rank = {
                "gf": ranks(base_summaries, "gf"),
                "ga": ranks(base_summaries, "ga", True),
                "goal_diff": ranks(base_summaries, "goal_diff"),
                "total": ranks(base_summaries, "total"),
                "corsi": ranks(base_summaries, "corsi"),
                "fenwick": ranks(base_summaries, "fenwick"),
                "p2_diff": ranks(base_summaries, "p2_diff"),
            }
            adv_rank = {
                "xgf_pct": ranks(adv_summaries, "xgf_pct"),
                "xgf60": ranks(adv_summaries, "xgf60"),
                "xga60": ranks(adv_summaries, "xga60", True),
                "corsi": ranks(adv_summaries, "corsi"),
                "fenwick": ranks(adv_summaries, "fenwick"),
            }
            snapshot_by_window[window] = (base_summaries, adv_summaries, base_rank, adv_rank)

        for g in group:
            for team, opp in ((g["away_tri"], g["home_tri"]), (g["home_tri"], g["away_tri"])):
                for window in WINDOWS:
                    base_summaries, adv_summaries, base_rank, adv_rank = snapshot_by_window[window]
                    b = base_summaries.get(team)
                    a = adv_summaries.get(team)
                    if not b and not a:
                        continue
                    db.execute(
                        """
                        INSERT OR REPLACE INTO pregame_team_snapshots_local VALUES(
                          ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
                        )
                        """,
                        (
                            g["game_pk"],team,opp,window,window if b else 0,len(base_summaries),
                            b.get("gf") if b else None,b.get("ga") if b else None,b.get("goal_diff") if b else None,b.get("total") if b else None,
                            b.get("corsi") if b else None,b.get("fenwick") if b else None,b.get("p2_diff") if b else None,
                            base_rank["gf"].get(team),base_rank["ga"].get(team),base_rank["goal_diff"].get(team),base_rank["total"].get(team),
                            base_rank["corsi"].get(team),base_rank["fenwick"].get(team),base_rank["p2_diff"].get(team),
                            window if a else 0,len(adv_summaries),a.get("xgf_pct") if a else None,a.get("xgf60") if a else None,a.get("xga60") if a else None,
                            a.get("corsi") if a else None,a.get("fenwick") if a else None,a.get("pdo") if a else None,a.get("gsax") if a else None,
                            adv_rank["xgf_pct"].get(team),adv_rank["xgf60"].get(team),adv_rank["xga60"].get(team),adv_rank["corsi"].get(team),
                            adv_rank["fenwick"].get(team),now_iso,
                        ),
                    )
                    inserted += 1
        for g in group:
            for team in (g["away_tri"], g["home_tri"]):
                f = features.get(int(g["game_pk"]), {}).get(team)
                if f:
                    base_hist[team].append(f)
                a = advanced.get(int(g["game_pk"]), {}).get(team)
                if a:
                    adv_hist[team].append(a)
        if idx % 250 == 0:
            print(f"TEAM SNAPSHOTS: processed {idx}/{len(by_time)} start-times", flush=True)
    db.commit()
    return inserted


def rows_as_dicts(db, table):
    return [dict(r) for r in db.execute(f"SELECT * FROM {table}")]


def export_supplemental_chunks(db):
    CHUNK_ROOT.mkdir(parents=True, exist_ok=True)
    active_ids = {
        int(r[0]) for r in db.execute("SELECT DISTINCT player_id FROM player_rolling_snapshots_local UNION SELECT DISTINCT player_id FROM goalie_rolling_snapshots_local")
    }
    players = []
    if active_ids:
        marks = ",".join("?" for _ in active_ids)
        players = [dict(r) for r in db.execute(f"SELECT * FROM players_compact_local WHERE player_id IN ({marks}) ORDER BY player_id", tuple(sorted(active_ids)))]

    counts = {}
    chunks = {}
    counts["players"], chunks["players"] = write_chunks(
        "070_players", "players", players, ["player_id"],
        update_cols=["first_name_en","last_name_en","full_name_en","current_team_tri","position_code","sweater_number","shoots_catches","active","last_seen_game_start_utc","last_seen_game_pk"],
        batch=200,
    )
    for prefix, table, local, conflicts, batch in (
        ("080_team_snapshots","pregame_team_snapshots","pregame_team_snapshots_local",["game_pk","team_tri","window_games"],180),
        ("090_player_rolling","player_rolling_snapshots","player_rolling_snapshots_local",["player_id","window_key"],180),
        ("100_player_opponents","player_opponent_splits","player_opponent_splits_local",["player_id","opponent_tri","scope_key"],180),
        ("110_goalie_rolling","goalie_rolling_snapshots","goalie_rolling_snapshots_local",["player_id","window_key"],180),
        ("120_goalie_opponents","goalie_opponent_splits","goalie_opponent_splits_local",["player_id","opponent_tri","scope_key"],180),
    ):
        rows = rows_as_dicts(db, local)
        counts[table], chunks[table] = write_chunks(prefix, table, rows, conflicts, batch=batch)
    return counts, chunks


def validate(db, player_parse, team_snapshot_rows):
    official = int(db.execute("SELECT COUNT(*) FROM games WHERE game_type IN (2,3)").fetchone()[0])
    if official != 2792:
        raise RuntimeError(f"expected 2792 official games, found {official}")
    if player_parse["parsed_games"] != official:
        raise RuntimeError(f"expected player parser to process {official} games, got {player_parse['parsed_games']}")
    if player_parse["missing_raw"]:
        raise RuntimeError(f"missing raw files for {len(player_parse['missing_raw'])} games")
    player_games = int(db.execute("SELECT COUNT(*) FROM player_game_features_local").fetchone()[0])
    goalie_games = int(db.execute("SELECT COUNT(*) FROM goalie_game_features_local").fetchone()[0])
    if player_games < 70000:
        raise RuntimeError(f"unexpectedly low skater game rows: {player_games}")
    if goalie_games < 5000:
        raise RuntimeError(f"unexpectedly low goalie game rows: {goalie_games}")
    if team_snapshot_rows < 10000:
        raise RuntimeError(f"unexpectedly low team snapshot rows: {team_snapshot_rows}")
    return {"official_games": official, "player_game_rows_local": player_games, "goalie_game_rows_local": goalie_games}


def main():
    if not DB_PATH.exists():
        raise SystemExit(f"Missing {DB_PATH}. Build the local warehouse first.")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    create_local_schema(db)
    print("PLAYERS: parsing official NHL boxscores locally...", flush=True)
    player_parse = load_player_game_history(db)
    player_meta = build_player_aggregates(db, now_iso)
    print("TEAM SNAPSHOTS: building exact pregame rolling/rank context locally...", flush=True)
    team_snapshot_rows = build_team_snapshots(db, now_iso)
    validation = validate(db, player_parse, team_snapshot_rows)
    counts, chunks = export_supplemental_chunks(db)
    summary = {
        "ok": True,
        "created_at": now_iso,
        "validation": validation,
        "player_parse": player_parse,
        "player_meta": player_meta,
        "local_rows": {
            "pregame_team_snapshots": team_snapshot_rows,
            "player_rolling_snapshots": db.execute("SELECT COUNT(*) FROM player_rolling_snapshots_local").fetchone()[0],
            "player_opponent_splits": db.execute("SELECT COUNT(*) FROM player_opponent_splits_local").fetchone()[0],
            "goalie_rolling_snapshots": db.execute("SELECT COUNT(*) FROM goalie_rolling_snapshots_local").fetchone()[0],
            "goalie_opponent_splits": db.execute("SELECT COUNT(*) FROM goalie_opponent_splits_local").fetchone()[0],
        },
        "d1_rows": counts,
        "d1_chunks": chunks,
        "supplemental_writes_estimate": sum(counts.values()),
        "sqlite": str(DB_PATH),
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    db.close()


if __name__ == "__main__":
    main()
