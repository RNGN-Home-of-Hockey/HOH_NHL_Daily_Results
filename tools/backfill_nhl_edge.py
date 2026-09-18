#!/usr/bin/env python3
"""Backfill public NHL EDGE season-level tracking profiles for two HOH seasons.

Sources:
- https://api-web.nhle.com/v1/edge/team-detail/{teamId}/{season}/{gameType}
- https://api-web.nhle.com/v1/edge/skater-detail/{playerId}/{season}/{gameType}
- https://api-web.nhle.com/v1/edge/goalie-detail/{playerId}/{season}/{gameType}
- league landing endpoints for team/skater/goalie

Entity lists are sourced from the official NHL Stats REST summary reports.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

STATS_BASE="https://api.nhle.com/stats/rest/en"
EDGE_BASE="https://api-web.nhle.com/v1/edge"
UA="HOH-NHL-EDGE/1.0"
SEASONS=("20242025","20252026")
GAME_TYPES=(2,3)

def parse_args():
    p=argparse.ArgumentParser()
    p.add_argument("--out",default="local-data/nhl-edge")
    p.add_argument("--workers",type=int,default=12)
    p.add_argument("--timeout",type=int,default=35)
    p.add_argument("--attempts",type=int,default=4)
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
                time.sleep(min(8,0.7*(2**(attempt-1))))
    raise RuntimeError(f"{url}: {last}")

def stats_summary(entity,season,game_type,timeout,attempts):
    query=urllib.parse.urlencode({
        "isAggregate":"false","isGame":"false","start":"0","limit":"-1",
        "cayenneExp":f"seasonId={season} and gameTypeId={game_type}",
    })
    url=f"{STATS_BASE}/{entity}/summary?{query}"
    payload=fetch_json(url,timeout,attempts)
    data=payload.get("data") if isinstance(payload,dict) else None
    return data if isinstance(data,list) else []

def first_int(row,*keys):
    for key in keys:
        try:
            v=int(row.get(key))
            if v>0:return v
        except (TypeError,ValueError):
            pass
    return None

def first_str(row,*keys):
    for key in keys:
        v=row.get(key)
        if v not in (None,""):
            return str(v).strip()
    return None

def entity_lists(season,game_type,timeout,attempts):
    teams={}
    skaters={}
    goalies={}
    for row in stats_summary("team",season,game_type,timeout,attempts):
        tid=first_int(row,"teamId","team_id")
        tri=first_str(row,"teamAbbrevs","teamAbbrev","teamTriCode","triCode")
        if tid:teams[tid]=(tri or "").upper()
    for row in stats_summary("skater",season,game_type,timeout,attempts):
        pid=first_int(row,"playerId","player_id")
        tri=first_str(row,"teamAbbrevs","teamAbbrev")
        if pid:skaters[pid]=(tri or "").upper()
    for row in stats_summary("goalie",season,game_type,timeout,attempts):
        pid=first_int(row,"playerId","player_id")
        tri=first_str(row,"teamAbbrevs","teamAbbrev")
        if pid:goalies[pid]=(tri or "").upper()
    return teams,skaters,goalies

def norm_key(value):
    return re.sub(r"[^a-z0-9]","",str(value).lower())

def scalar(value,prefer=("value","imperial","pctg","percentage")):
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        return value
    if isinstance(value,dict):
        for key in prefer:
            if key in value and isinstance(value[key],(int,float)) and not isinstance(value[key],bool):
                return value[key]
    return None

def recursive_candidates(obj,target_keys):
    wanted={norm_key(k) for k in target_keys}
    found=[]
    def walk(v,path=()):
        if isinstance(v,dict):
            for k,val in v.items():
                nk=norm_key(k)
                if nk in wanted:
                    found.append((path+(k,),val))
                walk(val,path+(k,))
        elif isinstance(v,list):
            for i,val in enumerate(v):
                walk(val,path+(str(i),))
    walk(obj)
    return found

def pick_metric(obj,keys,prefer=("value","imperial","pctg","percentage")):
    for _,value in recursive_candidates(obj,keys):
        v=scalar(value,prefer)
        if v is not None:return v
    return None

def location_rows(payload):
    out=[]
    def walk(v):
        if isinstance(v,dict):
            code=first_str(v,"locationCode","location","area","zone")
            if code:
                out.append(v)
            for val in v.values():walk(val)
        elif isinstance(v,list):
            for val in v:walk(val)
    walk(payload)
    return out

def high_danger_features(payload):
    result={
        "high_danger_shots":None,
        "high_danger_goals":None,
        "high_danger_saves":None,
        "high_danger_goals_against":None,
        "high_danger_save_pct":None,
    }
    for row in location_rows(payload):
        code=(first_str(row,"locationCode","location","area","zone") or "").lower()
        if "high" not in code and code not in {"hd","highdanger"}:
            continue
        mapping={
            "high_danger_shots":("shots","shotsOnGoal","sog","shotCount"),
            "high_danger_goals":("goals","goalCount"),
            "high_danger_saves":("saves","saveCount"),
            "high_danger_goals_against":("goalsAgainst","ga"),
            "high_danger_save_pct":("savePctg","savePercentage","savePct"),
        }
        for dst,keys in mapping.items():
            if result[dst] is not None:continue
            for key in keys:
                if key in row:
                    val=scalar(row[key])
                    if val is not None:
                        result[dst]=val
                        break
        if any(v is not None for v in result.values()):
            break
    return result

def extract_features(payload):
    f={}
    f["top_shot_speed_mph"]=pick_metric(payload,(
        "topShotSpeed","maxShotSpeed","shotSpeedMax"
    ),prefer=("imperial","value"))
    f["skating_speed_max_mph"]=pick_metric(payload,(
        "speedMax","maxSkatingSpeed","topSkatingSpeed"
    ),prefer=("imperial","value"))
    f["bursts_over_20"]=pick_metric(payload,(
        "burstsOver20","burstCountOver20","speedBurstsOver20"
    ))
    f["bursts_over_22"]=pick_metric(payload,(
        "burstsOver22","burstCountOver22","speedBurstsOver22"
    ))
    f["distance_miles"]=pick_metric(payload,(
        "totalDistanceSkated","totalDistance","distanceSkatedTotal"
    ),prefer=("imperial","value"))
    f["offensive_zone_pct"]=pick_metric(payload,(
        "offensiveZonePctg","offensiveZonePercentage","ozPctg"
    ))
    f["neutral_zone_pct"]=pick_metric(payload,(
        "neutralZonePctg","neutralZonePercentage","nzPctg"
    ))
    f["defensive_zone_pct"]=pick_metric(payload,(
        "defensiveZonePctg","defensiveZonePercentage","dzPctg"
    ))
    f.update(high_danger_features(payload))
    return f

def edge_url(entity_type,entity_id,season,game_type):
    return f"{EDGE_BASE}/{entity_type}-detail/{entity_id}/{season}/{game_type}"

def fetch_entity(task,timeout,attempts,fetched_at):
    season,game_type,entity_type,entity_id,entity_key=task
    url=edge_url(entity_type,entity_id,season,game_type)
    payload=fetch_json(url,timeout,attempts)
    return {
        "season_id":season,"game_type":game_type,"entity_type":entity_type,
        "entity_id":entity_id,"entity_key":entity_key,"report_name":f"{entity_type}_detail",
        "payload":payload,"features":extract_features(payload),"url":url,"fetched_at":fetched_at,
    }

def fetch_landing(task,timeout,attempts,fetched_at):
    season,game_type,kind=task
    url=f"{EDGE_BASE}/{kind}-landing/{season}/{game_type}"
    payload=fetch_json(url,timeout,attempts)
    return {
        "season_id":season,"game_type":game_type,"entity_type":"league",
        "entity_id":0,"entity_key":kind.upper(),"report_name":f"{kind}_landing",
        "payload":payload,"url":url,"fetched_at":fetched_at,
    }

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):return str(v)
    return "'"+str(v).replace("'","''")+"'"

def payload_value(row):
    vals=[
        row["season_id"],row["game_type"],row["entity_type"],row["entity_id"],
        row["entity_key"],row["report_name"],
        json.dumps(row["payload"],ensure_ascii=False,sort_keys=True,separators=(",",":")),
        row["fetched_at"],
    ]
    return "("+",".join(q(v) for v in vals)+")"

def feature_value(row):
    f=row["features"]
    feature_json=json.dumps(f,ensure_ascii=False,sort_keys=True,separators=(",",":"))
    vals=[
        row["season_id"],row["game_type"],row["entity_type"],row["entity_id"],row["entity_key"],
        f.get("top_shot_speed_mph"),f.get("skating_speed_max_mph"),
        f.get("bursts_over_20"),f.get("bursts_over_22"),f.get("distance_miles"),
        f.get("offensive_zone_pct"),f.get("neutral_zone_pct"),f.get("defensive_zone_pct"),
        f.get("high_danger_shots"),f.get("high_danger_goals"),
        f.get("high_danger_saves"),f.get("high_danger_goals_against"),
        f.get("high_danger_save_pct"),feature_json,
    ]
    return "("+",".join(q(v) for v in vals)+")"

def make_statements(values,header,tail,max_rows=100,max_bytes=60000):
    out=[];current=[];used=len(header.encode())+len(tail.encode())
    for value in values:
        size=len(value.encode("utf-8"))+2
        if current and (len(current)>=max_rows or used+size>max_bytes):
            out.append(header+",\n".join(current)+tail);current=[];used=len(header.encode())+len(tail.encode())
        current.append(value);used+=size
    if current:out.append(header+",\n".join(current)+tail)
    return out

def write_sql(out_dir,rows,landings):
    sql_dir=out_dir/"sql";sql_dir.mkdir(parents=True,exist_ok=True)
    for old in sql_dir.glob("*.sql"):old.unlink()

    payload_header="""INSERT INTO nhl_edge_payloads (
  season_id,game_type,entity_type,entity_id,entity_key,report_name,payload_json,fetched_at
) VALUES
"""
    payload_tail="""
ON CONFLICT(season_id,game_type,entity_type,entity_id,report_name) DO UPDATE SET
  entity_key=excluded.entity_key,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at;
"""
    feature_header="""INSERT INTO nhl_edge_features (
  season_id,game_type,entity_type,entity_id,entity_key,
  top_shot_speed_mph,skating_speed_max_mph,bursts_over_20,bursts_over_22,distance_miles,
  offensive_zone_pct,neutral_zone_pct,defensive_zone_pct,
  high_danger_shots,high_danger_goals,high_danger_saves,high_danger_goals_against,
  high_danger_save_pct,feature_json
) VALUES
"""
    feature_tail="""
ON CONFLICT(season_id,game_type,entity_type,entity_id) DO UPDATE SET
  entity_key=excluded.entity_key,top_shot_speed_mph=excluded.top_shot_speed_mph,
  skating_speed_max_mph=excluded.skating_speed_max_mph,bursts_over_20=excluded.bursts_over_20,
  bursts_over_22=excluded.bursts_over_22,distance_miles=excluded.distance_miles,
  offensive_zone_pct=excluded.offensive_zone_pct,neutral_zone_pct=excluded.neutral_zone_pct,
  defensive_zone_pct=excluded.defensive_zone_pct,high_danger_shots=excluded.high_danger_shots,
  high_danger_goals=excluded.high_danger_goals,high_danger_saves=excluded.high_danger_saves,
  high_danger_goals_against=excluded.high_danger_goals_against,
  high_danger_save_pct=excluded.high_danger_save_pct,feature_json=excluded.feature_json,
  computed_at=CURRENT_TIMESTAMP;
"""
    statements=make_statements([payload_value(r) for r in rows+landings],payload_header,payload_tail)
    statements+=make_statements([feature_value(r) for r in rows],feature_header,feature_tail,200,60000)

    files=[];parts=[];used=0
    for statement in statements:
        size=len(statement.encode("utf-8"))+1
        if parts and used+size>2_000_000:
            path=sql_dir/f"edge_data_{len(files):03d}.sql"
            path.write_text("\n".join(parts),encoding="utf-8")
            files.append(path);parts=[];used=0
        parts.append(statement);used+=size
    if parts:
        path=sql_dir/f"edge_data_{len(files):03d}.sql"
        path.write_text("\n".join(parts),encoding="utf-8")
        files.append(path)

    meta=f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('nhl_edge.payload_rows','{len(rows)+len(landings)}',CURRENT_TIMESTAMP),
('nhl_edge.feature_rows','{len(rows)}',CURRENT_TIMESTAMP),
('nhl_edge.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
"""
    (sql_dir/"edge_meta.sql").write_text(meta,encoding="utf-8")
    return files

def main():
    args=parse_args()
    out_dir=Path(args.out);out_dir.mkdir(parents=True,exist_ok=True)
    fetched_at=dt.datetime.now(dt.timezone.utc).isoformat()
    tasks=[];entity_counts=[]
    for season in SEASONS:
        for gt in GAME_TYPES:
            teams,skaters,goalies=entity_lists(season,gt,args.timeout,args.attempts)
            entity_counts.append({
                "season":season,"game_type":gt,
                "teams":len(teams),"skaters":len(skaters),"goalies":len(goalies),
            })
            tasks += [(season,gt,"team",eid,key) for eid,key in teams.items()]
            tasks += [(season,gt,"skater",eid,key) for eid,key in skaters.items()]
            tasks += [(season,gt,"goalie",eid,key) for eid,key in goalies.items()]

    land_tasks=[(s,g,k) for s in SEASONS for g in GAME_TYPES for k in ("team","skater","goalie")]
    rows=[];landings=[];failures=[]
    workers=max(1,min(args.workers,16))
    print(f"EDGE entity_tasks={len(tasks)} landing_tasks={len(land_tasks)} workers={workers}",flush=True)

    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        fmap={pool.submit(fetch_entity,t,args.timeout,args.attempts,fetched_at):("entity",t) for t in tasks}
        fmap.update({pool.submit(fetch_landing,t,args.timeout,args.attempts,fetched_at):("landing",t) for t in land_tasks})
        done=0
        for future in cf.as_completed(fmap):
            kind,task=fmap[future]
            done+=1
            try:
                item=future.result()
                if kind=="entity":rows.append(item)
                else:landings.append(item)
            except Exception as exc:
                failures.append({"kind":kind,"task":list(task),"error":str(exc)})
            if done%250==0 or done==len(fmap):
                print(f"EDGE {done}/{len(fmap)} entities={len(rows)} landings={len(landings)} failures={len(failures)}",flush=True)

    rows.sort(key=lambda x:(x["season_id"],x["game_type"],x["entity_type"],x["entity_id"]))
    landings.sort(key=lambda x:(x["season_id"],x["game_type"],x["report_name"]))
    files=write_sql(out_dir,rows,landings)
    nonnull={}
    for metric in (
        "top_shot_speed_mph","skating_speed_max_mph","bursts_over_20","bursts_over_22",
        "distance_miles","offensive_zone_pct","high_danger_save_pct"
    ):
        nonnull[metric]=sum(1 for row in rows if row["features"].get(metric) is not None)
    summary={
        "ok":bool(rows),"entity_tasks":len(tasks),"landing_tasks":len(land_tasks),
        "entity_rows":len(rows),"landing_rows":len(landings),"failures":len(failures),
        "sql_files":len(files),"entity_counts":entity_counts,"nonnull_features":nonnull,
        "failure_details":failures,"fetched_at":fetched_at,
    }
    (out_dir/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k!="failure_details"},ensure_ascii=False),flush=True)
    if not rows:raise SystemExit("No NHL EDGE data collected")

if __name__=="__main__":
    main()
