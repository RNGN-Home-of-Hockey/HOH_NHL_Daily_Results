#!/usr/bin/env python3
"""Backfill NBA game/team/player box scores from official NBA schedule + live CDN.

Schedule source: data.nba.com (season schedule, one request per season)
Box score source: cdn.nba.com/static/json/liveData/boxscore (one request per game)

The script emits idempotent SQL for the nba_* tables. Individual INSERT statements
are intentionally kept small for Cloudflare D1's SQL statement-size limit.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import math
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_SEASONS = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]
SCHEDULE_URL = "https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/{year}/league/00_full_schedule.json"
BOX_URL = "https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{game_id}.json"
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nba.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
}
GAME_TYPE = {"001": "Preseason", "002": "Regular Season", "004": "Playoffs", "005": "Play-In", "006": "NBA Cup Final"}
DEFAULT_TYPES = {"002", "004", "005", "006"}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--seasons", nargs="+", default=DEFAULT_SEASONS)
    p.add_argument("--output-dir", default="local-data/nba-cdn")
    p.add_argument("--workers", type=int, default=12)
    p.add_argument("--timeout", type=int, default=30)
    p.add_argument("--attempts", type=int, default=5)
    p.add_argument("--statement-rows", type=int, default=150)
    p.add_argument("--statements-per-file", type=int, default=50)
    p.add_argument("--include-preseason", action="store_true")
    p.add_argument("--allow-failures", type=int, default=0)
    return p.parse_args()


def fetch_bytes(url: str, timeout: int, attempts: int) -> bytes:
    last = None
    for n in range(1, attempts + 1):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=timeout) as r:
                if getattr(r, "status", 200) != 200:
                    raise HTTPError(url, r.status, f"HTTP {r.status}", r.headers, None)
                return r.read()
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last = exc
            if n >= attempts:
                break
            time.sleep(min(20.0, 0.8 * (2 ** (n - 1))) + random.uniform(0.1, 0.8))
    raise RuntimeError(f"fetch failed {url}: {last}")


def fetch_json(url: str, timeout: int, attempts: int):
    raw = fetch_bytes(url, timeout, attempts)
    return json.loads(raw.decode("utf-8-sig")), raw


def schedule_games(payload: dict, season: str, include_preseason: bool) -> list[dict]:
    allowed = set(DEFAULT_TYPES)
    if include_preseason:
        allowed.add("001")
    out = []
    seen = set()
    for league in payload.get("lscd") or []:
        month = league.get("mscd") or {}
        for g in month.get("g") or []:
            gid = str(g.get("gid") or "").strip()
            status_text = str(g.get("stt") or "").strip().lower()
            status_code = str(g.get("st") or "").strip()
            if len(gid) != 10 or gid[:3] not in allowed or gid in seen:
                continue
            if status_code != "3" and "final" not in status_text:
                continue
            seen.add(gid)
            out.append({
                "game_id": gid,
                "season_year": season,
                "season_type": GAME_TYPE.get(gid[:3], gid[:3]),
                "game_date": str(g.get("gdte") or g.get("gdtutc") or "")[:10],
                "status": str(g.get("stt") or ""),
                "home": g.get("h") or {},
                "away": g.get("v") or {},
            })
    out.sort(key=lambda x: (x["game_date"], x["game_id"]))
    return out


def number(v, integer=False):
    if v is None or v == "":
        return None
    try:
        x = float(v)
        if not math.isfinite(x):
            return None
        return int(round(x)) if integer else x
    except (TypeError, ValueError):
        return None


def minutes(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", s)
    if m:
        return float(m.group(1) or 0) * 60 + float(m.group(2) or 0) + float(m.group(3) or 0) / 60
    try:
        if ":" in s:
            a, b = s.split(":", 1)
            return float(a) + float(b) / 60
        return float(s)
    except ValueError:
        return None


def pct(stats, key):
    return number(stats.get(key))


def game_date_from_box(game: dict, fallback: str) -> str:
    for k in ("gameTimeLocal", "gameTimeUTC", "gameEt"):
        v = str(game.get(k) or "")
        if re.match(r"^\d{4}-\d{2}-\d{2}", v):
            return v[:10]
    return fallback


def played(player: dict) -> bool:
    v = player.get("played")
    if v in (1, True, "1", "true", "TRUE"):
        return True
    return (minutes((player.get("statistics") or {}).get("minutes")) or 0) > 0


def full_name(player: dict) -> str:
    return (str(player.get("name") or "").strip()
            or " ".join(x for x in [str(player.get("firstName") or "").strip(), str(player.get("familyName") or "").strip()] if x).strip()
            or str(player.get("personId") or "Unknown"))


def team_name(team: dict) -> str:
    city = str(team.get("teamCity") or "").strip()
    name = str(team.get("teamName") or "").strip()
    return " ".join(x for x in (city, name) if x).strip() or name or city


def normalize_box(schedule_row: dict, payload: dict):
    game = payload.get("game") or {}
    gid = str(game.get("gameId") or schedule_row["game_id"])
    if gid != schedule_row["game_id"]:
        raise ValueError(f"game id mismatch expected={schedule_row['game_id']} got={gid}")
    if int(number(game.get("gameStatus"), integer=True) or 0) != 3 and "final" not in str(game.get("gameStatusText") or "").lower():
        raise ValueError(f"game {gid} is not final: {game.get('gameStatusText')!r}")
    home = game.get("homeTeam") or {}
    away = game.get("awayTeam") or {}
    if not home.get("teamId") or not away.get("teamId"):
        raise ValueError(f"game {gid} missing teams")
    gd = game_date_from_box(game, schedule_row["game_date"])
    hs = number(home.get("score"), integer=True); aways = number(away.get("score"), integer=True)
    if hs is None or aways is None:
        raise ValueError(f"game {gid} missing final score")
    season = schedule_row["season_year"]; stype = schedule_row["season_type"]
    home_abbr = str(home.get("teamTricode") or schedule_row["home"].get("ta") or "").strip()
    away_abbr = str(away.get("teamTricode") or schedule_row["away"].get("ta") or "").strip()
    teams, teamfacts, playerdims, playerfacts = [], [], [], []
    for is_home, team, opp_abbr, score, opp_score in ((1, home, away_abbr, hs, aways), (0, away, home_abbr, aways, hs)):
        tid = int(team["teamId"]); abbr = str(team.get("teamTricode") or "").strip(); tname = team_name(team)
        teams.append([tid, abbr, tname, gd, gid])
        ts = team.get("statistics") or {}
        matchup = f"{abbr} vs. {opp_abbr}" if is_home else f"{abbr} @ {opp_abbr}"
        wl = "W" if score > opp_score else "L"
        teamfacts.append([gid, tid, season, stype, gd, abbr, tname, matchup, wl, is_home,
            minutes(ts.get("minutes")), number(ts.get("fieldGoalsMade"), True), number(ts.get("fieldGoalsAttempted"), True), pct(ts,"fieldGoalsPercentage"),
            number(ts.get("threePointersMade"), True), number(ts.get("threePointersAttempted"), True), pct(ts,"threePointersPercentage"),
            number(ts.get("freeThrowsMade"), True), number(ts.get("freeThrowsAttempted"), True), pct(ts,"freeThrowsPercentage"),
            number(ts.get("reboundsOffensive"), True), number(ts.get("reboundsDefensive"), True), number(ts.get("reboundsTotal"), True),
            number(ts.get("assists"), True), number(ts.get("turnoversTotal", ts.get("turnovers")), True), number(ts.get("steals"), True),
            number(ts.get("blocks"), True), number(ts.get("blocksReceived"), True), number(ts.get("foulsPersonal"), True), number(ts.get("foulsDrawn"), True),
            number(ts.get("points"), True), score - opp_score])
        for p in team.get("players") or []:
            if not played(p):
                continue
            pid = int(p["personId"]); name = full_name(p); ps = p.get("statistics") or {}
            pts = number(ps.get("points"), True) or 0; reb = number(ps.get("reboundsTotal"), True) or 0; ast = number(ps.get("assists"), True) or 0
            stl = number(ps.get("steals"), True) or 0; blk = number(ps.get("blocks"), True) or 0; tov = number(ps.get("turnovers"), True) or 0
            cats = sum(1 for x in (pts, reb, ast, stl, blk) if x >= 10)
            fantasy = pts + 1.2*reb + 1.5*ast + 3*stl + 3*blk - tov
            playerdims.append([pid, name, tid, abbr, gd, gid])
            playerfacts.append([gid, pid, season, stype, gd, name, tid, abbr, tname, matchup, wl,
                minutes(ps.get("minutes")), number(ps.get("fieldGoalsMade"), True), number(ps.get("fieldGoalsAttempted"), True), pct(ps,"fieldGoalsPercentage"),
                number(ps.get("threePointersMade"), True), number(ps.get("threePointersAttempted"), True), pct(ps,"threePointersPercentage"),
                number(ps.get("freeThrowsMade"), True), number(ps.get("freeThrowsAttempted"), True), pct(ps,"freeThrowsPercentage"),
                number(ps.get("reboundsOffensive"), True), number(ps.get("reboundsDefensive"), True), reb, ast, tov, stl, blk,
                number(ps.get("blocksReceived"), True), number(ps.get("foulsPersonal"), True), number(ps.get("foulsDrawn"), True), pts,
                number(ps.get("plusMinusPoints")), round(fantasy, 3), 1 if cats >= 2 else 0, 1 if cats >= 3 else 0])
    grow = [gid, season, stype, gd, int(home["teamId"]), int(away["teamId"]), home_abbr, away_abbr, hs, aways, "FINAL"]
    return teams, grow, teamfacts, playerdims, playerfacts


def sqlval(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "1" if v else "0"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v): return "NULL"
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]


def insert(table, cols, rows, conflict):
    if not rows: return ""
    values = ",\n".join("(" + ",".join(sqlval(x) for x in r) + ")" for r in rows)
    return f"INSERT INTO {table} ({','.join(cols)}) VALUES\n{values}\n{conflict};\n"


def upsert_all(cols, keys):
    return "ON CONFLICT(" + ",".join(keys) + ") DO UPDATE SET " + ", ".join(f"{c}=excluded.{c}" for c in cols if c not in keys) + ", updated_at=CURRENT_TIMESTAMP"


def write_files(sql_dir: Path, season: str, statements: list[str], per_file: int):
    prefix = season.replace("-", "")
    files = []
    clean = [s for s in statements if s.strip()]
    for idx, group in enumerate(chunks(clean, per_file), 1):
        path = sql_dir / f"nba_cdn_{prefix}_{idx:03d}.sql"
        path.write_text("PRAGMA foreign_keys = ON;\n" + "\n".join(group), encoding="utf-8")
        files.append(path)
    return files


def dedupe_latest(rows, key_index, date_index, game_index):
    d = {}
    for r in rows:
        k = r[key_index]
        if k not in d or (r[date_index], r[game_index]) > (d[k][date_index], d[k][game_index]):
            d[k] = r
    return list(d.values())


def season_statements(teams, games, teamfacts, playerdims, playerfacts, manifest, statement_rows):
    team_cols = ["team_id","abbreviation","team_name","last_seen_game_date","last_seen_game_id"]
    team_conf = "ON CONFLICT(team_id) DO UPDATE SET abbreviation=excluded.abbreviation,team_name=COALESCE(excluded.team_name,nba_teams.team_name),last_seen_game_date=CASE WHEN COALESCE(nba_teams.last_seen_game_date,'')<=excluded.last_seen_game_date THEN excluded.last_seen_game_date ELSE nba_teams.last_seen_game_date END,last_seen_game_id=CASE WHEN COALESCE(nba_teams.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_teams.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_teams.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.last_seen_game_id ELSE nba_teams.last_seen_game_id END,updated_at=CURRENT_TIMESTAMP"
    game_cols = ["game_id","season_year","season_type","game_date","home_team_id","away_team_id","home_team_abbr","away_team_abbr","home_score","away_score","game_status"]
    t_cols = ["game_id","team_id","season_year","season_type","game_date","team_abbr","team_name","matchup","wl","is_home","minutes","fgm","fga","fg_pct","fg3m","fg3a","fg3_pct","ftm","fta","ft_pct","oreb","dreb","reb","ast","tov","stl","blk","blka","pf","pfd","pts","plus_minus"]
    p_dim_cols = ["player_id","full_name","current_team_id","current_team_abbr","last_seen_game_date","last_seen_game_id"]
    p_dim_conf = "ON CONFLICT(player_id) DO UPDATE SET full_name=excluded.full_name,current_team_id=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.current_team_id ELSE nba_players.current_team_id END,current_team_abbr=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.current_team_abbr ELSE nba_players.current_team_abbr END,last_seen_game_date=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<=excluded.last_seen_game_date THEN excluded.last_seen_game_date ELSE nba_players.last_seen_game_date END,last_seen_game_id=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.last_seen_game_id ELSE nba_players.last_seen_game_id END,updated_at=CURRENT_TIMESTAMP"
    p_cols = ["game_id","player_id","season_year","season_type","game_date","player_name","team_id","team_abbr","team_name","matchup","wl","minutes","fgm","fga","fg_pct","fg3m","fg3a","fg3_pct","ftm","fta","ft_pct","oreb","dreb","reb","ast","tov","stl","blk","blka","pf","pfd","pts","plus_minus","nba_fantasy_pts","dd2","td3"]
    statements = []
    for c in chunks(dedupe_latest(teams, 0, 3, 4), statement_rows): statements.append(insert("nba_teams", team_cols, c, team_conf))
    for c in chunks(games, statement_rows): statements.append(insert("nba_games", game_cols, c, upsert_all(game_cols,["game_id"])))
    for c in chunks(teamfacts, statement_rows): statements.append(insert("nba_team_game_stats", t_cols, c, upsert_all(t_cols,["game_id","team_id"])))
    for c in chunks(dedupe_latest(playerdims, 0, 4, 5), statement_rows): statements.append(insert("nba_players", p_dim_cols, c, p_dim_conf))
    for c in chunks(playerfacts, statement_rows): statements.append(insert("nba_player_game_stats", p_cols, c, upsert_all(p_cols,["game_id","player_id"])))
    mcols=["season_year","season_type","source","player_rows","team_rows","game_rows","first_game_date","last_game_date","player_payload_sha256","team_payload_sha256","fetched_at","schedule_payload_sha256","boxscore_payload_sha256","failed_game_count"]
    mconf=upsert_all(mcols,["season_year","season_type"])
    for row in manifest: statements.append(insert("nba_sync_manifest",mcols,[row],mconf))
    return statements


def main():
    a = parse_args()
    root = Path(a.output_dir); raw_dir = root / "raw"; sql_dir = root / "sql"
    raw_dir.mkdir(parents=True, exist_ok=True); sql_dir.mkdir(parents=True, exist_ok=True)
    for old in sql_dir.glob("*.sql"): old.unlink()
    total_failures = 0; all_summary=[]
    for season in a.seasons:
        year = season.split("-",1)[0]
        print(f"=== schedule {season} ===", flush=True)
        sched, sched_raw = fetch_json(SCHEDULE_URL.format(year=year), a.timeout, a.attempts)
        (raw_dir / f"schedule_{season}.json").write_bytes(sched_raw)
        games_sched = schedule_games(sched, season, a.include_preseason)
        if not games_sched: raise RuntimeError(f"no games found for {season}")
        print(f"{season}: {len(games_sched)} scheduled target games", flush=True)
        teams=[]; games=[]; teamfacts=[]; playerdims=[]; playerfacts=[]; failures=[]
        box_hash = hashlib.sha256(); raw_path = raw_dir / f"boxscores_{season}.jsonl.gz"; results = {}
        def job(row):
            try:
                payload, raw = fetch_json(BOX_URL.format(game_id=row["game_id"]), a.timeout, a.attempts)
                return row["game_id"], row, payload, raw, None
            except Exception as exc:
                return row["game_id"], row, None, None, str(exc)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,a.workers)) as ex:
            futs=[ex.submit(job,row) for row in games_sched]
            done=0
            for fut in concurrent.futures.as_completed(futs):
                gid,row,payload,raw,err=fut.result(); results[gid]=(row,payload,raw,err); done+=1
                if done % 100 == 0 or done == len(futs): print(f"{season}: fetched {done}/{len(futs)}", flush=True)
        with gzip.open(raw_path,"wt",encoding="utf-8") as gz:
            for row in games_sched:
                gid=row["game_id"]; _,payload,raw,err=results[gid]
                if err:
                    failures.append({"game_id":gid,"season_type":row["season_type"],"error":err}); continue
                box_hash.update(gid.encode()); box_hash.update(b"\0"); box_hash.update(raw); box_hash.update(b"\n")
                gz.write(json.dumps(payload,separators=(",",":"),ensure_ascii=False)+"\n")
                try:
                    t,g,tf,pd,pf=normalize_box(row,payload)
                    teams.extend(t); games.append(g); teamfacts.extend(tf); playerdims.extend(pd); playerfacts.extend(pf)
                except Exception as exc:
                    failures.append({"game_id":gid,"season_type":row["season_type"],"error":f"normalize: {exc}"})
        total_failures += len(failures)
        if failures:
            (raw_dir / f"failures_{season}.json").write_text(json.dumps(failures,indent=2,ensure_ascii=False),encoding="utf-8")
        manifest=[]; now=datetime.now(timezone.utc).isoformat(); schedule_sha=hashlib.sha256(sched_raw).hexdigest(); box_sha=box_hash.hexdigest()
        for stype in sorted({g[2] for g in games}):
            gs=[g for g in games if g[2]==stype]; ids={g[0] for g in gs}; tf=[r for r in teamfacts if r[0] in ids]; pf=[r for r in playerfacts if r[0] in ids]
            failed_type=sum(1 for f in failures if f["season_type"]==stype); dates=[g[3] for g in gs]
            manifest.append([season,stype,"cdn.nba.com+data.nba.com",len(pf),len(tf),len(gs),min(dates) if dates else None,max(dates) if dates else None,None,None,now,schedule_sha,box_sha,failed_type])
            all_summary.append({"season":season,"season_type":stype,"games":len(gs),"team_rows":len(tf),"player_rows":len(pf),"failed_games":failed_type})
        statements=season_statements(teams,games,teamfacts,playerdims,playerfacts,manifest,a.statement_rows)
        files=write_files(sql_dir,season,statements,a.statements_per_file)
        print(f"{season}: games={len(games)} team_rows={len(teamfacts)} player_rows={len(playerfacts)} failures={len(failures)} sql_files={len(files)}",flush=True)
    summary={"generated_at":datetime.now(timezone.utc).isoformat(),"seasons":a.seasons,"total_failures":total_failures,"rows":all_summary}
    (root/"summary.json").write_text(json.dumps(summary,indent=2,ensure_ascii=False),encoding="utf-8")
    if total_failures > a.allow_failures:
        raise RuntimeError(f"NBA CDN backfill had {total_failures} failed games; allowed={a.allow_failures}")
    print(json.dumps(summary,indent=2),flush=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
