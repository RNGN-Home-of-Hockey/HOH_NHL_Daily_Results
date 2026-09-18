#!/usr/bin/env python3
"""Build pregame NHL schedule-load features for the two canonical HOH seasons."""
from __future__ import annotations
import datetime as dt, json, re
from collections import defaultdict, deque
from pathlib import Path

SRC=Path("migrations/0017_nhl_two_season_games.sql")
OUT=Path("local-data/schedule-load")
GAME_RE=re.compile(
 r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',",re.M
)

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):return str(v)
    return "'"+str(v).replace("'","''")+"'"

def load():
    text=SRC.read_text(encoding="utf-8");games=[]
    for m in GAME_RE.finditer(text):
        pk,season,gt,start,home,away=m.groups()
        games.append(dict(game_pk=int(pk),season_id=season,game_type=int(gt),scheduled_start_utc=start,
                          date=dt.date.fromisoformat(start[:10]),home_tri=home,away_tri=away))
    return sorted(games,key=lambda g:(g["season_id"],g["scheduled_start_utc"],g["game_pk"]))

def main():
    games=load()
    by_team=defaultdict(list)
    for g in games:
        by_team[(g["season_id"],g["home_tri"])].append((g,1,g["away_tri"]))
        by_team[(g["season_id"],g["away_tri"])].append((g,0,g["home_tri"]))

    rows=[]
    for (season,team),items in by_team.items():
        items.sort(key=lambda x:(x[0]["scheduled_start_utc"],x[0]["game_pk"]))
        prior=[]
        home_streak=road_streak=0
        for g,is_home,opp in items:
            prev=prior[-1] if prior else None
            if prev:
                delta=(g["date"]-prev["date"]).days
                rest=max(0,delta-1)
                prev_pk=prev["game_pk"]
            else:
                rest=None;prev_pk=None
            p3=sum(1 for x in prior if 1 <= (g["date"]-x["date"]).days <= 3)
            p5=sum(1 for x in prior if 1 <= (g["date"]-x["date"]).days <= 5)
            p7=sum(1 for x in prior if 1 <= (g["date"]-x["date"]).days <= 7)
            if is_home:
                home_streak=home_streak+1 if prior and prior[-1]["is_home"] else 1
                road_streak=0
            else:
                road_streak=road_streak+1 if prior and not prior[-1]["is_home"] else 1
                home_streak=0
            row={
              "game_pk":g["game_pk"],"season_id":season,"game_type":g["game_type"],
              "scheduled_start_utc":g["scheduled_start_utc"],"team_tri":team,"opponent_tri":opp,
              "is_home":is_home,"rest_days":rest,"opponent_rest_days":None,"rest_advantage_days":None,
              "is_back_to_back":int(rest==0) if rest is not None else 0,
              "is_3_in_4":int(p3>=2),"is_4_in_6":int(p5>=3),
              "games_prev_3d":p3,"games_prev_5d":p5,"games_prev_7d":p7,
              "current_home_stand_game":home_streak if is_home else 0,
              "current_road_trip_game":road_streak if not is_home else 0,
              "previous_game_pk":prev_pk,
            }
            rows.append(row)
            prior.append({"game_pk":g["game_pk"],"date":g["date"],"is_home":bool(is_home)})

    lookup={(r["game_pk"],r["team_tri"]):r for r in rows}
    for r in rows:
        opp=lookup.get((r["game_pk"],r["opponent_tri"]))
        if opp:
            r["opponent_rest_days"]=opp["rest_days"]
            if r["rest_days"] is not None and opp["rest_days"] is not None:
                r["rest_advantage_days"]=r["rest_days"]-opp["rest_days"]

    rows.sort(key=lambda r:(r["game_pk"],r["team_tri"]))
    cols=("game_pk","season_id","game_type","scheduled_start_utc","team_tri","opponent_tri","is_home",
          "rest_days","opponent_rest_days","rest_advantage_days","is_back_to_back","is_3_in_4","is_4_in_6",
          "games_prev_3d","games_prev_5d","games_prev_7d","current_home_stand_game","current_road_trip_game","previous_game_pk")
    values=[("(" + ",".join(q(r[c]) for c in cols) + ")") for r in rows]
    chunks=[];size=200
    for i in range(0,len(values),size):
        vals=values[i:i+size]
        updates=",".join(f"{c}=excluded.{c}" for c in cols if c not in ("game_pk","team_tri"))
        chunks.append(f"INSERT INTO team_schedule_load ({','.join(cols)}) VALUES\n"+",\n".join(vals)+
                      f"\nON CONFLICT(game_pk,team_tri) DO UPDATE SET {updates},computed_at=CURRENT_TIMESTAMP;\n")
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/"schedule_load.sql").write_text("\n".join(chunks)+
      f"\nINSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES ('schedule_load.rows','{len(rows)}',CURRENT_TIMESTAMP) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;\n",
      encoding="utf-8")
    summary={
      "ok":len(rows)==len(games)*2,"games":len(games),"rows":len(rows),
      "b2b_rows":sum(r["is_back_to_back"] for r in rows),
      "three_in_four_rows":sum(r["is_3_in_4"] for r in rows),
      "four_in_six_rows":sum(r["is_4_in_6"] for r in rows),
      "road_trip_game_3_plus":sum(r["current_road_trip_game"]>=3 for r in rows),
      "rest_advantage_rows":sum((r["rest_advantage_days"] or 0)>0 for r in rows),
    }
    (OUT/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False),flush=True)

if __name__=="__main__":main()
