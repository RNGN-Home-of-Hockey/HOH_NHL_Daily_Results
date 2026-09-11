#!/usr/bin/env python3
import datetime as dt
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

import build_compact_snapshots as compact

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "local-data" / "warehouse" / "hoh_history.sqlite"
SUMMARY_PATH = ROOT / "local-data" / "warehouse" / "current-team-snapshots-summary.json"
WINDOWS = (5, 10, 20)


def create_local_table(db):
    db.executescript(
        """
        DROP TABLE IF EXISTS team_current_snapshots_local;
        CREATE TABLE team_current_snapshots_local (
          team_tri TEXT NOT NULL,
          window_games INTEGER NOT NULL,
          as_of_utc TEXT NOT NULL,
          sample_size INTEGER NOT NULL,
          league_teams INTEGER,
          gf_pg REAL,
          ga_pg REAL,
          goal_diff_pg REAL,
          total_pg REAL,
          corsi_pct REAL,
          fenwick_pct REAL,
          p2_diff_pg REAL,
          rank_gf INTEGER,
          rank_ga INTEGER,
          rank_goal_diff INTEGER,
          rank_total INTEGER,
          rank_corsi INTEGER,
          rank_fenwick INTEGER,
          rank_p2_diff INTEGER,
          advanced_sample_size INTEGER,
          advanced_league_teams INTEGER,
          xgf_pct_5v5 REAL,
          xgf60_5v5 REAL,
          xga60_5v5 REAL,
          corsi_pct_5v5 REAL,
          fenwick_pct_5v5 REAL,
          pdo_5v5 REAL,
          gsax_5v5 REAL,
          rank_xgf_pct_5v5 INTEGER,
          rank_xgf60_5v5 INTEGER,
          rank_xga60_5v5 INTEGER,
          rank_corsi_pct_5v5 INTEGER,
          rank_fenwick_pct_5v5 INTEGER,
          computed_at TEXT NOT NULL,
          PRIMARY KEY (team_tri, window_games)
        );
        """
    )


def histories(db):
    base = defaultdict(list)
    advanced = defaultdict(list)
    for row in db.execute(
        "SELECT * FROM team_game_features WHERE game_type IN (2,3) ORDER BY team_tri,scheduled_start_utc,game_pk"
    ):
        base[row["team_tri"]].append(dict(row))
    for row in db.execute(
        """
        SELECT a.*,g.scheduled_start_utc,g.game_type
        FROM team_game_advanced_features a
        JOIN games g ON g.game_pk=a.game_pk
        WHERE g.game_type IN (2,3)
        ORDER BY a.team_tri,g.scheduled_start_utc,a.game_pk
        """
    ):
        advanced[row["team_tri"]].append(dict(row))
    return base, advanced


def build(db, now_iso):
    create_local_table(db)
    base_hist, adv_hist = histories(db)
    inserted = 0

    for window in WINDOWS:
        base_summaries = {
            team: compact.base_summary(rows[-window:])
            for team, rows in base_hist.items()
            if len(rows) >= window
        }
        adv_summaries = {
            team: compact.advanced_summary(rows[-window:])
            for team, rows in adv_hist.items()
            if len(rows) >= window
        }
        adv_summaries = {team: value for team, value in adv_summaries.items() if value is not None}

        base_rank = {
            "gf": compact.ranks(base_summaries, "gf"),
            "ga": compact.ranks(base_summaries, "ga", True),
            "goal_diff": compact.ranks(base_summaries, "goal_diff"),
            "total": compact.ranks(base_summaries, "total"),
            "corsi": compact.ranks(base_summaries, "corsi"),
            "fenwick": compact.ranks(base_summaries, "fenwick"),
            "p2_diff": compact.ranks(base_summaries, "p2_diff"),
        }
        adv_rank = {
            "xgf_pct": compact.ranks(adv_summaries, "xgf_pct"),
            "xgf60": compact.ranks(adv_summaries, "xgf60"),
            "xga60": compact.ranks(adv_summaries, "xga60", True),
            "corsi": compact.ranks(adv_summaries, "corsi"),
            "fenwick": compact.ranks(adv_summaries, "fenwick"),
        }

        for team, b in sorted(base_summaries.items()):
            a = adv_summaries.get(team)
            as_of = base_hist[team][-1]["scheduled_start_utc"]
            db.execute(
                """
                INSERT OR REPLACE INTO team_current_snapshots_local VALUES(
                  ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
                )
                """,
                (
                    team, window, as_of, window, len(base_summaries),
                    b.get("gf"), b.get("ga"), b.get("goal_diff"), b.get("total"),
                    b.get("corsi"), b.get("fenwick"), b.get("p2_diff"),
                    base_rank["gf"].get(team), base_rank["ga"].get(team),
                    base_rank["goal_diff"].get(team), base_rank["total"].get(team),
                    base_rank["corsi"].get(team), base_rank["fenwick"].get(team),
                    base_rank["p2_diff"].get(team),
                    window if a else 0, len(adv_summaries),
                    a.get("xgf_pct") if a else None,
                    a.get("xgf60") if a else None,
                    a.get("xga60") if a else None,
                    a.get("corsi") if a else None,
                    a.get("fenwick") if a else None,
                    a.get("pdo") if a else None,
                    a.get("gsax") if a else None,
                    adv_rank["xgf_pct"].get(team), adv_rank["xgf60"].get(team),
                    adv_rank["xga60"].get(team), adv_rank["corsi"].get(team),
                    adv_rank["fenwick"].get(team), now_iso,
                ),
            )
            inserted += 1
    db.commit()
    return inserted


def export(db):
    rows = [dict(r) for r in db.execute("SELECT * FROM team_current_snapshots_local ORDER BY window_games,team_tri")]
    count, chunks = compact.write_chunks(
        "125_team_current",
        "team_current_snapshots",
        rows,
        ["team_tri", "window_games"],
        batch=100,
    )
    return count, chunks


def main():
    if not DB_PATH.exists():
        raise SystemExit(f"Missing {DB_PATH}. Build the local warehouse first.")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    inserted = build(db, now_iso)
    count, chunks = export(db)
    by_window = {
        str(window): db.execute(
            "SELECT COUNT(*) FROM team_current_snapshots_local WHERE window_games=?", (window,)
        ).fetchone()[0]
        for window in WINDOWS
    }
    if inserted != count:
        raise RuntimeError(f"local/export row mismatch: {inserted} != {count}")
    if any(value < 30 for value in by_window.values()):
        raise RuntimeError(f"unexpectedly low current-team coverage: {by_window}")
    summary = {
        "ok": True,
        "created_at": now_iso,
        "rows": count,
        "chunks": chunks,
        "by_window": by_window,
        "sqlite": str(DB_PATH),
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    db.close()


if __name__ == "__main__":
    main()
