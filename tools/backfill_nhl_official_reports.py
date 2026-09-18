#!/usr/bin/env python3
"""Backfill official NHL Stats REST reports for the two historical HOH seasons.

The script is stdlib-only. It downloads season-level report rows and emits
idempotent SQL chunks for Cloudflare D1. It does not talk to D1 directly.

Sources:
- https://api.nhle.com/stats/rest/en/team/{report}
- https://api.nhle.com/stats/rest/en/skater/{report}
- https://api.nhle.com/stats/rest/en/goalie/{report}
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.nhle.com/stats/rest/en"
UA = "HOH-NHL-Official-Reports/1.0"

DEFAULT_SEASONS = ("20242025", "20252026")
DEFAULT_GAME_TYPES = (2, 3)

REPORTS = {
    "team": (
        "summary",
        "faceoffpercentages",
        "faceoffwins",
        "goalsForAgainst",
        "outshootopponent",
        "powerplay",
        "penaltykill",
        "pointspergame",
        "realtime",
        "shootout",
        "shotattemptsagainst",
    ),
    "skater": (
        "summary",
        "realtime",
        "powerplay",
        "penaltykill",
        "puckpossessions",
        "summaryshooting",
        "percentages",
        "scoringRates",
        "scoringpergame",
        "shottype",
        "timeonice",
        "faceoffpercentages",
    ),
    "goalie": (
        "summary",
        "advanced",
        "daysrest",
        "savesByStrength",
        "startedVsRelieved",
        "shootout",
    ),
}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--season", action="append", default=[])
    p.add_argument("--game-type", action="append", type=int, default=[])
    p.add_argument("--out", default="local-data/nhl-official-reports")
    p.add_argument("--chunk-size", type=int, default=200)
    p.add_argument("--timeout", type=int, default=45)
    p.add_argument("--attempts", type=int, default=5)
    return p.parse_args()


def fetch_json(url: str, timeout: int, attempts: int):
    last = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"Accept": "application/json", "User-Agent": UA},
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in {429, 500, 502, 503, 504}:
                raise
            if attempt < attempts:
                time.sleep(min(8, 0.75 * (2 ** (attempt - 1))))
    raise RuntimeError(f"Failed {url}: {last}")


def report_url(entity_type: str, report: str, season: str, game_type: int) -> str:
    query = urllib.parse.urlencode({
        "isAggregate": "false",
        "isGame": "false",
        "start": "0",
        "limit": "-1",
        "cayenneExp": f"seasonId={season} and gameTypeId={game_type}",
    })
    return f"{BASE}/{entity_type}/{report}?{query}"


def team_tri(row: dict):
    for key in ("teamAbbrevs", "teamAbbrev", "teamTriCode", "rawTricode", "triCode"):
        value = row.get(key)
        if value:
            raw = str(value).strip().upper()
            if "," in raw:
                return None
            if len(raw) in (3, 4):
                return raw
    return None


def player_id(row: dict):
    for key in ("playerId", "player_id"):
        value = row.get(key)
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    return None


def base_row_key(entity_type: str, row: dict, idx: int) -> str:
    if entity_type == "team":
        for key in ("teamId", "teamFullName", "teamName", "teamAbbrevs", "teamAbbrev"):
            if row.get(key) not in (None, ""):
                return str(row[key])
    else:
        pid = player_id(row)
        if pid is not None:
            team = row.get("teamAbbrevs") or row.get("teamAbbrev") or ""
            return f"{pid}:{team}"
    stable = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"row-{idx}-{hashlib.sha1(stable.encode('utf-8')).hexdigest()[:16]}"


def sql_quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def row_sql(season, game_type, entity_type, report, row_key, row, fetched_at):
    payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    values = [
        season,
        game_type,
        entity_type,
        report,
        row_key,
        team_tri(row),
        player_id(row),
        payload,
        fetched_at,
    ]
    return "(" + ",".join(sql_quote(v) for v in values) + ")"


def write_chunks(out_dir: Path, rows: list[str], chunk_size: int):
    sql_dir = out_dir / "sql"
    sql_dir.mkdir(parents=True, exist_ok=True)
    for old in sql_dir.glob("*.sql"):
        old.unlink()
    for start in range(0, len(rows), chunk_size):
        chunk = rows[start:start + chunk_size]
        statement = """INSERT INTO nhl_official_stat_reports (
  season_id,game_type,entity_type,report_name,row_key,team_tri,player_id,payload_json,fetched_at
) VALUES
""" + ",\n".join(chunk) + """
ON CONFLICT(season_id,game_type,entity_type,report_name,row_key) DO UPDATE SET
  team_tri=excluded.team_tri,
  player_id=excluded.player_id,
  payload_json=excluded.payload_json,
  fetched_at=excluded.fetched_at;
"""
        (sql_dir / f"official_{start // chunk_size:04d}.sql").write_text(statement, encoding="utf-8")

    meta = f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('nhl_official_reports.rows','{len(rows)}',CURRENT_TIMESTAMP),
('nhl_official_reports.seasons','20242025,20252026',CURRENT_TIMESTAMP),
('nhl_official_reports.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
"""
    (sql_dir / "official_meta.sql").write_text(meta, encoding="utf-8")
    return sql_dir


def main():
    args = parse_args()
    seasons = tuple(args.season) or DEFAULT_SEASONS
    game_types = tuple(args.game_type) or DEFAULT_GAME_TYPES
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    fetched_at = dt.datetime.now(dt.timezone.utc).isoformat()
    sql_rows = []
    manifest = []
    failures = []

    for season in seasons:
        for game_type in game_types:
            for entity_type, reports in REPORTS.items():
                for report in reports:
                    url = report_url(entity_type, report, season, game_type)
                    try:
                        payload = fetch_json(url, args.timeout, args.attempts)
                        data = payload.get("data") if isinstance(payload, dict) else None
                        data = data if isinstance(data, list) else []
                        seen = {}
                        for idx, row in enumerate(data):
                            if not isinstance(row, dict):
                                continue
                            key = base_row_key(entity_type, row, idx)
                            occurrence = seen.get(key, 0)
                            seen[key] = occurrence + 1
                            if occurrence:
                                key = f"{key}:{occurrence + 1}"
                            sql_rows.append(row_sql(
                                season, game_type, entity_type, report, key, row, fetched_at
                            ))
                        manifest.append({
                            "season": season,
                            "game_type": game_type,
                            "entity_type": entity_type,
                            "report": report,
                            "rows": len(data),
                            "url": url,
                        })
                        print(f"OK {season} GT{game_type} {entity_type}/{report}: {len(data)} rows", flush=True)
                    except Exception as exc:
                        failure = {
                            "season": season,
                            "game_type": game_type,
                            "entity_type": entity_type,
                            "report": report,
                            "url": url,
                            "error": str(exc),
                        }
                        failures.append(failure)
                        print(f"WARN {season} GT{game_type} {entity_type}/{report}: {exc}", flush=True)

    sql_dir = write_chunks(out_dir, sql_rows, max(25, args.chunk_size))
    summary = {
        "ok": len(sql_rows) > 0,
        "rows": len(sql_rows),
        "requests_ok": len(manifest),
        "requests_failed": len(failures),
        "seasons": list(seasons),
        "game_types": list(game_types),
        "sql_files": len(list(sql_dir.glob("*.sql"))),
        "fetched_at": fetched_at,
        "manifest": manifest,
        "failures": failures,
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        "ok": summary["ok"],
        "rows": summary["rows"],
        "requests_ok": summary["requests_ok"],
        "requests_failed": summary["requests_failed"],
        "sql_files": summary["sql_files"],
    }, ensure_ascii=False), flush=True)
    if not sql_rows:
        raise SystemExit("No NHL Stats rows downloaded")


if __name__ == "__main__":
    main()
