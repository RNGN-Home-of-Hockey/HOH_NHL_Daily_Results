#!/usr/bin/env python3
"""Collect official NHL skater/goalie milestone watch rows."""
from __future__ import annotations
import datetime as dt, json, urllib.request
from pathlib import Path

BASE="https://api.nhle.com/stats/rest/en/milestones"
UA="HOH-NHL-Milestones/1.0"

def fetch(kind):
    req=urllib.request.Request(f"{BASE}/{kind}",headers={"Accept":"application/json","User-Agent":UA})
    with urllib.request.urlopen(req,timeout=30) as r:
        payload=json.load(r)
    data=payload.get("data") if isinstance(payload,dict) else None
    return data if isinstance(data,list) else []

def current_value(kind,row):
    name=str(row.get("milestone") or "").strip().lower()
    mapping={
      "goals":"goals","assists":"assists","points":"points","games played":"gamesPlayed",
      "wins":"wins","shutouts":"so","minutes played":"toiMinutes",
    }
    key=mapping.get(name)
    if not key:return None
    try:return float(row.get(key))
    except (TypeError,ValueError):return None

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):return str(v)
    return "'"+str(v).replace("'","''")+"'"

def main():
    fetched=dt.datetime.now(dt.timezone.utc).isoformat()
    rows=[]
    for kind in ("skaters","goalies"):
        entity="skater" if kind=="skaters" else "goalie"
        for row in fetch(kind):
            try:
                pid=int(row["playerId"]);gt=int(row["gameTypeId"]);amount=int(row["milestoneAmount"])
            except (KeyError,TypeError,ValueError):
                continue
            cur=current_value(kind,row)
            rows.append({
              "entity_type":entity,"player_id":pid,"game_type":gt,
              "team_tri":row.get("teamAbbrev"),"player_name":row.get("playerFullName"),
              "milestone_type":row.get("milestone"),"milestone_amount":amount,
              "current_value":cur,"remaining_value":amount-cur if cur is not None else None,
              "games_played":row.get("gamesPlayed"),"goals":row.get("goals"),
              "assists":row.get("assists"),"points":row.get("points"),"wins":row.get("wins"),
              "shutouts":row.get("so"),"toi_minutes":row.get("toiMinutes"),"source_row_id":row.get("id"),
              "payload_json":json.dumps(row,ensure_ascii=False,sort_keys=True,separators=(",",":")),
              "fetched_at":fetched,
            })
    cols=("entity_type","player_id","game_type","team_tri","player_name","milestone_type","milestone_amount",
      "current_value","remaining_value","games_played","goals","assists","points","wins","shutouts","toi_minutes",
      "source_row_id","payload_json","fetched_at")
    values=[("(" + ",".join(q(r.get(c)) for c in cols) + ")") for r in rows]
    statements=["DELETE FROM nhl_milestone_watch;"]
    current=[];used=0
    header="INSERT INTO nhl_milestone_watch ("+",".join(cols)+") VALUES\n"
    for value in values:
        size=len(value.encode("utf-8"))+2
        if current and (len(current)>=50 or used+size>55_000):
            statements.append(header+",\n".join(current)+";")
            current=[];used=0
        current.append(value);used+=size
    if current:
        statements.append(header+",\n".join(current)+";")
    statements.append("""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('nhl_milestones.rows','%s',CURRENT_TIMESTAMP),
('nhl_milestones.last_fetch','%s',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;"""%(len(rows),fetched.replace("'","''")))
    sql="\n".join(statements)
    out=Path("local-data/nhl-milestones");out.mkdir(parents=True,exist_ok=True)
    (out/"milestones.sql").write_text(sql,encoding="utf-8")
    summary={
      "ok":bool(rows),"rows":len(rows),
      "skaters":sum(r["entity_type"]=="skater" for r in rows),
      "goalies":sum(r["entity_type"]=="goalie" for r in rows),
      "regular":sum(r["game_type"]==2 for r in rows),
      "playoffs":sum(r["game_type"]==3 for r in rows),
      "nearest":sorted([
        {"player":r["player_name"],"team":r["team_tri"],"milestone":r["milestone_type"],
         "target":r["milestone_amount"],"current":r["current_value"],"remaining":r["remaining_value"]}
        for r in rows if r["remaining_value"] is not None and r["remaining_value"]>=0
      ],key=lambda x:x["remaining"])[:25],
      "fetched_at":fetched,
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k!="nearest"},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
