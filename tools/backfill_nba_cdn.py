#!/usr/bin/env python3
"""Backfill NBA game/team/player box scores from official legacy data.nba.com feeds.

Schedule: data.nba.com mobile full_schedule (one request per season).
Boxscore: data.nba.com mobile gamedetail (one request per game).

The script emits idempotent, D1-safe SQL for the existing nba_* tables.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_SEASONS = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]
SCHEDULE_URL = "https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/{year}/league/00_full_schedule.json"
BOX_URL = "https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/{year}/scores/gamedetail/{game_id}_gamedetail.json"
SOURCE = "data.nba.com/v2015"
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
    out, seen = [], set()
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


def first(stats: dict, *keys):
    for k in keys:
        if k in stats and stats.get(k) not in (None, ""):
            return stats.get(k)
    return None


def ratio(made, attempted):
    m, a = number(made), number(attempted)
    return None if a in (None, 0) or m is None else m / a


def legacy_minutes(row: dict):
    total = number(row.get("totsec"))
    if total is not None:
        return total / 60.0
    mins = number(row.get("min"))
    secs = number(row.get("sec"))
    if mins is None and secs is None:
        return None
    return (mins or 0.0) + (secs or 0.0) / 60.0


def played_legacy(player: dict) -> bool:
    return (legacy_minutes(player) or 0) > 0


def full_name_legacy(player: dict) -> str:
    name = " ".join(x for x in [str(player.get("fn") or "").strip(), str(player.get("ln") or "").strip()] if x).strip()
    return name or str(player.get("pid") or "Unknown")


def team_name_legacy(team: dict) -> str:
    city = str(team.get("tc") or "").strip()
    name = str(team.get("tn") or "").strip()
    return " ".join(x for x in (city, name) if x).strip() or name or city


def team_score(team: dict, schedule_team: dict):
    value = first(team, "s", "pts") if team else None
    score = number(value, integer=True)
    return score if score is not None else number(first(schedule_team, "s", "pts"), integer=True)


def normalize_box(schedule_row: dict, payload: dict):
    game = payload.get("g") or {}
    gid = str(game.get("gid") or schedule_row["game_id"]).strip()
    if gid != schedule_row["game_id"]:
        raise ValueError(f"game id mismatch expected={schedule_row['game_id']} got={gid}")
    home, away = game.get("hls") or {}, game.get("vls") or {}
    if not home.get("tid") or not away.get("tid"):
        raise ValueError(f"game {gid} missing hls/vls teams")
    if not (home.get("pstsg") or []) or not (away.get("pstsg") or []):
        raise ValueError(f"game {gid} missing player stats")
    gd = str(game.get("gdte") or schedule_row["game_date"])[:10]
    hs = team_score(home, schedule_row["home"])
    aways = team_score(away, schedule_row["away"])
    if hs is None or aways is None:
        raise ValueError(f"game {gid} missing final score")

    season, stype = schedule_row["season_year"], schedule_row["season_type"]
    home_abbr = str(home.get("ta") or schedule_row["home"].get("ta") or "").strip()
    away_abbr = str(away.get("ta") or schedule_row["away"].get("ta") or "").strip()
    teams, teamfacts, playerdims, playerfacts = [], [], [], []

    for is_home, team, opp_abbr, score, opp_score in (
        (1, home, away_abbr, hs, aways),
        (0, away, home_abbr, aways, hs),
    ):
        tid = int(team["tid"])
        abbr = str(team.get("ta") or "").strip()
        tname = team_name_legacy(team)
        teams.append([tid, abbr, tname, gd, gid])
        ts = team.get("tstsg") or {}
        players = team.get("pstsg") or []
        matchup = f"{abbr} vs. {opp_abbr}" if is_home else f"{abbr} @ {opp_abbr}"
        wl = "W" if score > opp_score else "L"

        team_minutes = number(first(ts, "min"))
        if team_minutes is None:
            team_minutes = sum((legacy_minutes(p) or 0) for p in players)

        fgm, fga = first(ts, "fgm"), first(ts, "fga")
        tpm, tpa = first(ts, "tpm"), first(ts, "tpa")
        ftm, fta = first(ts, "ftm"), first(ts, "fta")
        teamfacts.append([
            gid, tid, season, stype, gd, abbr, tname, matchup, wl, is_home,
            team_minutes,
            number(fgm, True), number(fga, True), ratio(fgm, fga),
            number(tpm, True), number(tpa, True), ratio(tpm, tpa),
            number(ftm, True), number(fta, True), ratio(ftm, fta),
            number(first(ts, "oreb"), True), number(first(ts, "dreb"), True), number(first(ts, "reb"), True),
            number(first(ts, "ast"), True), number(first(ts, "tov"), True), number(first(ts, "stl"), True),
            number(first(ts, "blk"), True), number(first(ts, "blka"), True), number(first(ts, "pf"), True),
            number(first(ts, "pfd"), True), score, score - opp_score,
        ])

        for p in players:
            if not played_legacy(p):
                continue
            pid = int(p["pid"])
            name = full_name_legacy(p)
            pts = number(first(p, "pts"), True) or 0
            reb = number(first(p, "reb"), True) or 0
            ast = number(first(p, "ast"), True) or 0
            stl = number(first(p, "stl"), True) or 0
            blk = number(first(p, "blk"), True) or 0
            tov = number(first(p, "tov"), True) or 0
            cats = sum(1 for x in (pts, reb, ast, stl, blk) if x >= 10)
            fantasy = pts + 1.2 * reb + 1.5 * ast + 3 * stl + 3 * blk - tov
            pf_fgm, pf_fga = first(p, "fgm"), first(p, "fga")
            pf_tpm, pf_tpa = first(p, "tpm"), first(p, "tpa")
            pf_ftm, pf_fta = first(p, "ftm"), first(p, "fta")
            playerdims.append([pid, name, tid, abbr, gd, gid])
            playerfacts.append([
                gid, pid, season, stype, gd, name, tid, abbr, tname, matchup, wl,
                legacy_minutes(p),
                number(pf_fgm, True), number(pf_fga, True), ratio(pf_fgm, pf_fga),
                number(pf_tpm, True), number(pf_tpa, True), ratio(pf_tpm, pf_tpa),
                number(pf_ftm, True), number(pf_fta, True), ratio(pf_ftm, pf_fta),
                number(first(p, "oreb"), True), number(first(p, "dreb"), True), reb, ast, tov, stl, blk,
                number(first(p, "blka"), True), number(first(p, "pf"), True), number(first(p, "pfd"), True), pts,
                number(first(p, "pm")), round(fantasy, 3), 1 if cats >= 2 else 0, 1 if cats >= 3 else 0,
            ])

    grow = [gid, season, stype, gd, int(home["tid"]), int(away["tid"]), home_abbr, away_abbr, hs, aways, "FINAL"]
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
        path = sql_dir / f"nba_data_{prefix}_{idx:03d}.sql"
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
        if not games_sched: raise RuntimeError(f"no completed target games found for {season}")
        print(f"{season}: {len(games_sched)} completed target games", flush=True)
        teams=[]; games=[]; teamfacts=[]; playerdims=[]; playerfacts=[]; failures=[]
        box_hash = hashlib.sha256(); raw_path = raw_dir / f"boxscores_{season}.jsonl.gz"; results = {}

        def job(row):
            try:
                url = BOX_URL.format(year=year, game_id=row["game_id"])
                payload, raw = fetch_json(url, a.timeout, a.attempts)
                return row["game_id"], row, payload, raw, None
            except Exception as exc:
                return row["game_id"], row, None, None, str(exc)

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,a.workers)) as ex:
            futs=[ex.submit(job,row) for row in games_sched]
            done=0
            for fut in concurrent.futures.as_completed(futs):
                gid,row,payload,raw,err=fut.result(); results[gid]=(row,payload,raw,err); done+=1
                if done % 100 == 0 or done == len(futs):
                    print(f"{season}: fetched {done}/{len(futs)}", flush=True)

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
        scheduled_types=sorted({r["season_type"] for r in games_sched})
        for stype in scheduled_types:
            gs=[g for g in games if g[2]==stype]; ids={g[0] for g in gs}; tf=[r for r in teamfacts if r[0] in ids]; pf=[r for r in playerfacts if r[0] in ids]
            failed_type=sum(1 for f in failures if f["season_type"]==stype); dates=[g[3] for g in gs]
            manifest.append([season,stype,SOURCE,len(pf),len(tf),len(gs),min(dates) if dates else None,max(dates) if dates else None,None,None,now,schedule_sha,box_sha,failed_type])
            all_summary.append({"season":season,"season_type":stype,"games":len(gs),"team_rows":len(tf),"player_rows":len(pf),"failed_games":failed_type})

        statements=season_statements(teams,games,teamfacts,playerdims,playerfacts,manifest,a.statement_rows)
        files=write_files(sql_dir,season,statements,a.statements_per_file)
        print(f"{season}: games={len(games)} team_rows={len(teamfacts)} player_rows={len(playerfacts)} failures={len(failures)} sql_files={len(files)}",flush=True)

    summary={"generated_at":datetime.now(timezone.utc).isoformat(),"source":SOURCE,"seasons":a.seasons,"total_failures":total_failures,"rows":all_summary}
    (root/"summary.json").write_text(json.dumps(summary,indent=2,ensure_ascii=False),encoding="utf-8")
    if total_failures > a.allow_failures:
        raise RuntimeError(f"NBA data backfill had {total_failures} failed games; allowed={a.allow_failures}")
    print(json.dumps(summary,indent=2),flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
