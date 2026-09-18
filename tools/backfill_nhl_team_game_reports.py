#!/usr/bin/env python3
"""Collect additive official NHL team reports at per-game granularity.

The NHL Stats REST per-game rows expose gameDate + teamId rather than gamePk.
We map those rows back to the canonical HOH two-season schedule using the
unambiguous key (game_date, team_tri) -> game_pk.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE="https://api.nhle.com/stats/rest/en/team"
TEAM_LOOKUP="https://api.nhle.com/stats/rest/en/team"
UA="HOH-NHL-Team-Game-Reports/1.1"
GAME_SQL=Path("migrations/0017_nhl_two_season_games.sql")
SEASONS=("20242025","20252026")
GAME_TYPES=(2,3)
REPORTS=(
    "faceoffpercentages",
    "goalsagainstbystrength",
    "goalsbyperiod",
    "goalsforbystrength",
    "leadingtrailing",
    "penalties",
    "penaltykill",
    "powerplay",
    "scoretrailfirst",
)
GAME_RE=re.compile(
    r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',",
    re.M,
)

def parse_args():
    p=argparse.ArgumentParser()
    p.add_argument("--out",default="local-data/nhl-team-game-reports")
    p.add_argument("--workers",type=int,default=6)
    p.add_argument("--timeout",type=int,default=40)
    p.add_argument("--attempts",type=int,default=4)
    p.add_argument("--games-sql",default=str(GAME_SQL))
    return p.parse_args()

def fetch_json(url,timeout,attempts):
    last=None
    for attempt in range(1,attempts+1):
        try:
            req=urllib.request.Request(url,headers={"Accept":"application/json","User-Agent":UA})
            with urllib.request.urlopen(req,timeout=timeout) as response:
                return json.load(response)
        except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,json.JSONDecodeError) as exc:
            last=exc
            if isinstance(exc,urllib.error.HTTPError) and exc.code not in {408,425,429,500,502,503,504}:
                raise
            if attempt<attempts:
                time.sleep(min(6,0.6*(2**(attempt-1))))
    raise RuntimeError(str(last))

def load_schedule_map(path):
    text=Path(path).read_text(encoding="utf-8")
    mapping={}
    duplicate_keys=set()
    for m in GAME_RE.finditer(text):
        game_pk,season_id,game_type,start_utc,home_tri,away_tri=m.groups()
        if season_id not in SEASONS or int(game_type) not in GAME_TYPES:
            continue
        date=start_utc[:10]
        for tri in (home_tri,away_tri):
            key=(date,tri)
            if key in mapping and mapping[key]!=int(game_pk):
                duplicate_keys.add(key)
            mapping[key]=int(game_pk)
    for key in duplicate_keys:
        mapping.pop(key,None)
    return mapping,duplicate_keys

def load_team_map(timeout,attempts):
    payload=fetch_json(TEAM_LOOKUP,timeout,attempts)
    rows=payload.get("data") if isinstance(payload,dict) else None
    rows=rows if isinstance(rows,list) else []
    mapping={}
    for row in rows:
        try:
            tid=int(row.get("id"))
        except (TypeError,ValueError):
            continue
        tri=row.get("triCode") or row.get("rawTricode")
        if tri:
            mapping[tid]=str(tri).strip().upper()
    return mapping

def url_for(season,game_type,report):
    query=urllib.parse.urlencode({
        "isAggregate":"false","isGame":"true","start":"0","limit":"-1",
        "cayenneExp":f"seasonId={season} and gameTypeId={game_type}",
    })
    return f"{BASE}/{report}?{query}"

def direct_game_pk(row):
    for key in ("gameId","gamePk","gamePK","game_id"):
        try:
            value=int(row.get(key))
            if value>0:return value
        except (TypeError,ValueError):
            pass
    return None

def team_tri(row,team_map):
    for key in ("teamAbbrevs","teamAbbrev","teamTriCode","rawTricode","triCode"):
        value=row.get(key)
        if value:
            raw=str(value).strip().upper()
            if "," not in raw and 2<len(raw)<5:
                return raw
    for key in ("teamId","team_id"):
        try:
            tid=int(row.get(key))
        except (TypeError,ValueError):
            continue
        if tid in team_map:return team_map[tid]
    return None

def game_date(row):
    for key in ("gameDate","date","game_date"):
        value=row.get(key)
        if value:
            return str(value)[:10]
    return None

def resolve_game_pk(row,tri,schedule_map):
    pk=direct_game_pk(row)
    if pk is not None:return pk
    date=game_date(row)
    if date and tri:
        return schedule_map.get((date,tri))
    return None

def stable_key(row):
    return hashlib.sha1(
        json.dumps(row,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")
    ).hexdigest()[:20]

def fetch_report(task,timeout,attempts,fetched_at,schedule_map,team_map):
    season,game_type,report=task
    url=url_for(season,game_type,report)
    payload=fetch_json(url,timeout,attempts)
    data=payload.get("data") if isinstance(payload,dict) else None
    data=data if isinstance(data,list) else []
    rows=[];unmatched=0
    sample_unmatched=None
    for item in data:
        if not isinstance(item,dict):continue
        tri=team_tri(item,team_map)
        pk=resolve_game_pk(item,tri,schedule_map)
        if pk is None or tri is None:
            unmatched+=1
            if sample_unmatched is None:
                sample_unmatched={
                    "keys":sorted(item.keys()),
                    "gameDate":item.get("gameDate"),
                    "teamId":item.get("teamId"),
                    "teamTri":tri,
                }
            continue
        rows.append({
            "season_id":season,"game_type":game_type,"report_name":report,
            "game_pk":pk,"team_tri":tri,
            "row_key":f"{pk}:{tri}:{stable_key(item)}",
            "payload_json":json.dumps(item,ensure_ascii=False,sort_keys=True,separators=(",",":")),
            "fetched_at":fetched_at,
        })
    return {
        "season":season,"game_type":game_type,"report":report,"url":url,
        "api_rows":len(data),"matched_rows":len(rows),"unmatched_rows":unmatched,
        "sample_unmatched":sample_unmatched,"rows":rows,
    }

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):return str(v)
    return "'"+str(v).replace("'","''")+"'"

def value_sql(row):
    vals=[row["season_id"],row["game_type"],row["report_name"],row["game_pk"],
          row["team_tri"],row["row_key"],row["payload_json"],row["fetched_at"]]
    return "("+",".join(q(v) for v in vals)+")"

def make_statement(rows):
    return """INSERT INTO nhl_team_game_report_rows (
  season_id,game_type,report_name,game_pk,team_tri,row_key,payload_json,fetched_at
) VALUES
"""+",\n".join(rows)+"""
ON CONFLICT(report_name,game_pk,team_tri,row_key) DO UPDATE SET
  season_id=excluded.season_id,game_type=excluded.game_type,
  payload_json=excluded.payload_json,fetched_at=excluded.fetched_at;
"""

def write_sql(out_dir,rows):
    sql_dir=out_dir/"sql";sql_dir.mkdir(parents=True,exist_ok=True)
    for old in sql_dir.glob("*.sql"):old.unlink()
    statements=[];current=[];used=0
    for row in rows:
        value=value_sql(row);size=len(value.encode("utf-8"))+2
        if current and (len(current)>=120 or used+size>60_000):
            statements.append(make_statement(current));current=[];used=0
        current.append(value);used+=size
    if current:statements.append(make_statement(current))
    files=[];parts=[];used=0
    for statement in statements:
        size=len(statement.encode("utf-8"))+1
        if parts and used+size>2_000_000:
            path=sql_dir/f"team_game_data_{len(files):03d}.sql"
            path.write_text("\n".join(parts),encoding="utf-8")
            files.append(path);parts=[];used=0
        parts.append(statement);used+=size
    if parts:
        path=sql_dir/f"team_game_data_{len(files):03d}.sql"
        path.write_text("\n".join(parts),encoding="utf-8")
        files.append(path)
    meta=f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('nhl_team_game_reports.rows','{len(rows)}',CURRENT_TIMESTAMP),
('nhl_team_game_reports.seasons','20242025,20252026',CURRENT_TIMESTAMP),
('nhl_team_game_reports.version','2',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
"""
    (sql_dir/"team_game_meta.sql").write_text(meta,encoding="utf-8")
    return files

def main():
    args=parse_args()
    fetched_at=dt.datetime.now(dt.timezone.utc).isoformat()
    schedule_map,duplicates=load_schedule_map(args.games_sql)
    team_map=load_team_map(args.timeout,args.attempts)
    print(f"TEAM_GAME_MAP schedule_keys={len(schedule_map)} duplicate_keys={len(duplicates)} team_ids={len(team_map)}",flush=True)
    tasks=[(s,g,r) for s in SEASONS for g in GAME_TYPES for r in REPORTS]
    workers=max(1,min(args.workers,8))
    results=[];failures=[];rows=[]
    print(f"TEAM_GAME_REPORTS slices={len(tasks)} workers={workers}",flush=True)
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        fm={
            pool.submit(fetch_report,t,args.timeout,args.attempts,fetched_at,schedule_map,team_map):t
            for t in tasks
        }
        for future in cf.as_completed(fm):
            s,g,r=fm[future]
            try:
                result=future.result()
                rows.extend(result.pop("rows"))
                results.append(result)
                print(f"OK {s} GT{g} {r}: api={result['api_rows']} matched={result['matched_rows']} unmatched={result['unmatched_rows']}",flush=True)
                if result["sample_unmatched"]:
                    print("UNMATCHED_SAMPLE "+json.dumps(result["sample_unmatched"],ensure_ascii=False),flush=True)
            except Exception as exc:
                failures.append({"season":s,"game_type":g,"report":r,"error":str(exc),"url":url_for(s,g,r)})
                print(f"WARN {s} GT{g} {r}: {exc}",flush=True)

    rows.sort(key=lambda x:(x["season_id"],x["game_type"],x["report_name"],x["game_pk"],x["team_tri"],x["row_key"]))
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    files=write_sql(out,rows)
    summary={
        "ok":bool(rows),"requests_total":len(tasks),"requests_ok":len(results),
        "requests_failed":len(failures),"rows":len(rows),"sql_files":len(files),
        "schedule_keys":len(schedule_map),"duplicate_schedule_keys":len(duplicates),
        "results":sorted(results,key=lambda x:(x["season"],x["game_type"],x["report"])),
        "failures":failures,"fetched_at":fetched_at,
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k not in ("results","failures")},ensure_ascii=False),flush=True)
    if not rows:raise SystemExit("No team game report rows collected")

if __name__=="__main__":
    main()
