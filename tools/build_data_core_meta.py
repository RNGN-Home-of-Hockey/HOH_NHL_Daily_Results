#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WAREHOUSE = ROOT / "local-data" / "warehouse"
CHUNK_ROOT = WAREHOUSE / "d1-chunks"
BASE_SUMMARY = WAREHOUSE / "summary.json"
COMPACT_SUMMARY = WAREHOUSE / "compact-snapshots-summary.json"
CURRENT_SUMMARY = WAREHOUSE / "current-team-snapshots-summary.json"
OUTPUT = CHUNK_ROOT / "130_data_core_meta_0000.sql"


def load(path):
    if not path.exists():
        raise SystemExit(f"Missing {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("ok") is False:
        raise SystemExit(f"Summary reports ok=false: {path}")
    return value


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    base = load(BASE_SUMMARY)
    compact = load(COMPACT_SUMMARY)
    current = load(CURRENT_SUMMARY)

    base_rows = base.get("d1_rows") or {}
    compact_rows = compact.get("d1_rows") or {}
    current_rows = int(current.get("rows") or 0)

    if int(base_rows.get("games") or 0) != 2792:
        raise SystemExit(f"Expected 2792 base games, got {base_rows.get('games')}")
    if current_rows < 90:
        raise SystemExit(f"Unexpectedly low current team snapshot coverage: {current_rows}")

    meta = {
        "warehouse.games": int(base_rows.get("games") or 0),
        "warehouse.teams": int(base_rows.get("teams") or 0),
        "warehouse.period_scores": int(base_rows.get("period_scores") or 0),
        "warehouse.team_game_stats": int(base_rows.get("team_game_stats") or 0),
        "warehouse.team_game_features": int(base_rows.get("team_game_features") or 0),
        "warehouse.team_game_advanced_features": int(base_rows.get("team_game_advanced_features") or 0),
        "compact.players": int(compact_rows.get("players") or 0),
        "compact.pregame_team_snapshots": int(compact_rows.get("pregame_team_snapshots") or 0),
        "compact.player_rolling_snapshots": int(compact_rows.get("player_rolling_snapshots") or 0),
        "compact.player_opponent_splits": int(compact_rows.get("player_opponent_splits") or 0),
        "compact.goalie_rolling_snapshots": int(compact_rows.get("goalie_rolling_snapshots") or 0),
        "compact.goalie_opponent_splits": int(compact_rows.get("goalie_opponent_splits") or 0),
        "compact.team_current_snapshots": current_rows,
        "build.warehouse_created_at": base.get("created_at") or "",
        "build.compact_created_at": compact.get("created_at") or "",
        "build.current_created_at": current.get("created_at") or "",
        "build.seasons": "20242025,20252026",
        "build.rank_version": "2",
    }

    CHUNK_ROOT.mkdir(parents=True, exist_ok=True)
    for old in CHUNK_ROOT.glob("130_data_core_meta_*.sql"):
        old.unlink()

    values = ",\n".join(f"({q(key)},{q(value)},CURRENT_TIMESTAMP)" for key, value in sorted(meta.items()))
    OUTPUT.write_text(
        "INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES\n"
        + values
        + "\nON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;\n",
        encoding="utf-8",
    )

    print(json.dumps({"ok": True, "rows": len(meta), "chunk": str(OUTPUT), "meta": meta}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
