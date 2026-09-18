#!/usr/bin/env python3
"""Build compact two-season shot-context features from official NHL PBP.

No raw play-by-play is persisted to D1. The runner downloads PBP, derives
team/player game aggregates and H2H snapshots, then emits byte-bounded SQL.

Definitions are deliberately named HOH-derived:
- HOH slot: unblocked attempt within 30 ft of net and <=45 degrees.
- rebound: attempt within 4 seconds of the same team's immediately preceding SOG.
- quick transition: attempt within 8 seconds of an immediately preceding takeaway
  by the attacking team or giveaway by the opponent.
These are not official NHL xG/high-danger/rush classifications.
"""
from __future__ import annotations
import argparse, concurrent.futures as cf, datetime as dt, json, math, re, time
import urllib.error, urllib.request
from collections import defaultdict
from pathlib import Path

BASE="https://api-web.nhle.com/v1"
UA="HOH-NHL-ShotContext/1.0"
GAME_SQL=Path("migrations/0017_nhl_two_season_games.sql")
GAME_RE=re.compile(
    r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',",
    re.M,
)
SHOT_TYPES={"goal","shot-on-goal","missed-shot","blocked-shot"}
UNBLOCKED={"goal","shot-on-goal","missed-shot"}
SOG_TYPES={"goal","shot-on-goal"}

def args():
    p=argparse.ArgumentParser()
    p.add_argument("--games-sql",default=str(GAME_SQL))
    p.add_argument("--out",default="local-data/shot-context")
    p.add_argument("--workers",type=int,default=12)
    p.add_argument("--timeout",type=int,default=30)
    p.add_argument("--attempts",type=int,default=4)
    return p.parse_args()

def load_games(path):
    text=Path(path).read_text(encoding="utf-8")
    out=[]
    for m in GAME_RE.finditer(text):
        pk,season,gt,start,home,away=m.groups()
        out.append(dict(game_pk=int(pk),season_id=season,game_type=int(gt),start_utc=start,home_tri=home,away_tri=away))
    return out

def fetch_json(url,timeout,attempts):
    last=None
    for n in range(1,attempts+1):
        try:
            req=urllib.request.Request(url,headers={"Accept":"application/json","User-Agent":UA})
            with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
        except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,json.JSONDecodeError) as e:
            last=e
            if isinstance(e,urllib.error.HTTPError) and e.code not in {408,425,429,500,502,503,504}:raise
            if n<attempts:time.sleep(min(6,.5*(2**(n-1))))
    raise RuntimeError(str(last))

def sec(v):
    try:
        a,b=str(v).split(":");return int(a)*60+int(b)
    except Exception:return None

def intv(v):
    try:return int(v)
    except Exception:return None

def geometry(details):
    x=details.get("xCoord");y=details.get("yCoord")
    try:x=float(x);y=float(y)
    except (TypeError,ValueError):return None,None,False
    dx=89.0-abs(x)
    dist=math.hypot(dx,y)
    angle=math.degrees(math.atan2(abs(y),max(0.1,dx))) if dx>0 else 90.0
    slot=dist<=30.0 and angle<=45.0
    return dist,angle,slot

def shot_bucket(v):
    s=str(v or "").lower().replace(" ","-").replace("_","-")
    if "wrist" in s:return "wrist"
    if "snap" in s:return "snap"
    if "slap" in s:return "slap"
    if "backhand" in s:return "backhand"
    if "tip" in s:return "tip"
    if "deflect" in s:return "deflected"
    return "other"

def new_team(game,tri):
    return {
      "game_pk":game["game_pk"],"season_id":game["season_id"],"game_type":game["game_type"],
      "team_tri":tri,"opponent_tri":game["away_tri"] if tri==game["home_tri"] else game["home_tri"],
      "is_home":1 if tri==game["home_tri"] else 0,
      "shot_attempts":0,"unblocked_attempts":0,"shots_on_goal":0,"goals":0,
      "hoh_slot_attempts":0,"hoh_slot_sog":0,"hoh_slot_goals":0,
      "rebound_attempts":0,"rebound_sog":0,"rebound_goals":0,
      "quick_transition_attempts":0,"quick_transition_sog":0,"quick_transition_goals":0,
      "attempts_tied":0,"attempts_leading":0,"attempts_trailing":0,
      "distance_sum":0.0,"angle_sum":0.0,"geo_n":0,
      "wrist_attempts":0,"snap_attempts":0,"slap_attempts":0,"backhand_attempts":0,
      "tip_attempts":0,"deflected_attempts":0,"other_attempts":0,
    }

def new_player(game,tri,pid):
    return {
      "game_pk":game["game_pk"],"season_id":game["season_id"],"game_type":game["game_type"],
      "team_tri":tri,"player_id":pid,
      "shot_attempts":0,"unblocked_attempts":0,"shots_on_goal":0,"goals":0,
      "hoh_slot_attempts":0,"hoh_slot_sog":0,"hoh_slot_goals":0,
      "rebound_attempts":0,"rebound_sog":0,"rebound_goals":0,
      "quick_transition_attempts":0,"quick_transition_sog":0,"quick_transition_goals":0,
      "distance_sum":0.0,"angle_sum":0.0,"geo_n":0,"max_shot_distance_ft":None,
    }

def apply_common(row,is_unblocked,is_sog,is_goal,is_slot,is_rebound,is_transition,dist,angle):
    row["shot_attempts"]+=1
    if is_unblocked:row["unblocked_attempts"]+=1
    if is_sog:row["shots_on_goal"]+=1
    if is_goal:row["goals"]+=1
    if is_unblocked and is_slot:
        row["hoh_slot_attempts"]+=1
        if is_sog:row["hoh_slot_sog"]+=1
        if is_goal:row["hoh_slot_goals"]+=1
    if is_rebound:
        row["rebound_attempts"]+=1
        if is_sog:row["rebound_sog"]+=1
        if is_goal:row["rebound_goals"]+=1
    if is_transition:
        row["quick_transition_attempts"]+=1
        if is_sog:row["quick_transition_sog"]+=1
        if is_goal:row["quick_transition_goals"]+=1
    if dist is not None and is_unblocked:
        row["distance_sum"]+=dist;row["angle_sum"]+=angle;row["geo_n"]+=1
        if "max_shot_distance_ft" in row:
            row["max_shot_distance_ft"]=dist if row["max_shot_distance_ft"] is None else max(row["max_shot_distance_ft"],dist)

def finalize(row):
    n=row.pop("geo_n")
    ds=row.pop("distance_sum");ang=row.pop("angle_sum")
    row["avg_shot_distance_ft"]=round(ds/n,3) if n else None
    row["avg_shot_angle_deg"]=round(ang/n,3) if n else None
    return row

def fetch_game(game,timeout,attempts):
    url=f"{BASE}/gamecenter/{game['game_pk']}/play-by-play"
    pbp=fetch_json(url,timeout,attempts)
    home=pbp.get("homeTeam") or {};away=pbp.get("awayTeam") or {}
    idtri={}
    if intv(home.get("id")) is not None:idtri[intv(home.get("id"))]=str(home.get("abbrev") or game["home_tri"]).upper()
    if intv(away.get("id")) is not None:idtri[intv(away.get("id"))]=str(away.get("abbrev") or game["away_tri"]).upper()

    teams={game["home_tri"]:new_team(game,game["home_tri"]),game["away_tri"]:new_team(game,game["away_tri"])}
    players={}
    home_score=away_score=0
    previous=None

    for play in pbp.get("plays") or []:
        typ=str(play.get("typeDescKey") or "")
        details=play.get("details") or {}
        pn=intv((play.get("periodDescriptor") or {}).get("number"))
        now=sec(play.get("timeInPeriod"))
        owner=idtri.get(intv(details.get("eventOwnerTeamId")))

        if typ in SHOT_TYPES and owner:
            shot_team=(game["away_tri"] if owner==game["home_tri"] else game["home_tri"]) if typ=="blocked-shot" else owner
            if shot_team not in teams:continue
            is_unblocked=typ in UNBLOCKED;is_sog=typ in SOG_TYPES;is_goal=typ=="goal"
            pid=intv(details.get("scoringPlayerId") if is_goal else details.get("shootingPlayerId"))
            dist,angle,is_slot=geometry(details)
            rebound=False;transition=False
            if previous and pn==previous["period"] and now is not None and previous["time"] is not None:
                gap=now-previous["time"]
                if 0<=gap<=4 and previous["type"]=="shot-on-goal" and previous["team"]==shot_team:
                    rebound=True
                if 0<=gap<=8:
                    if previous["type"]=="takeaway" and previous["team"]==shot_team:transition=True
                    if previous["type"]=="giveaway" and previous["team"] and previous["team"]!=shot_team:transition=True

            tr=teams[shot_team]
            apply_common(tr,is_unblocked,is_sog,is_goal,is_slot,rebound,transition,dist,angle)
            bucket=shot_bucket(details.get("shotType"))
            tr[bucket+"_attempts"]+=1

            if shot_team==game["home_tri"]:gf,ga=home_score,away_score
            else:gf,ga=away_score,home_score
            tr["attempts_tied" if gf==ga else "attempts_leading" if gf>ga else "attempts_trailing"]+=1

            if pid is not None:
                key=(shot_team,pid)
                pr=players.setdefault(key,new_player(game,shot_team,pid))
                apply_common(pr,is_unblocked,is_sog,is_goal,is_slot,rebound,transition,dist,angle)

            if is_goal:
                if shot_team==game["home_tri"]:home_score+=1
                else:away_score+=1

        event_team=owner
        previous={"type":typ,"team":event_team,"period":pn,"time":now}

    return {
      "team_rows":[finalize(v) for v in teams.values()],
      "player_rows":[finalize(v) for v in players.values()],
      "url":url,
    }

def h2h(team_rows):
    groups={}
    for r in team_rows:
        for scope in ("2Y",f"S_{r['season_id']}"):
            key=(r["team_tri"],r["opponent_tri"],scope)
            g=groups.setdefault(key,{"team_tri":key[0],"opponent_tri":key[1],"scope_key":scope,"games":0,
                "shot_attempts":0,"sog":0,"goals":0,"slot_attempts":0,"slot_sog":0,
                "rebound_attempts":0,"rebound_goals":0,"transition_attempts":0})
            g["games"]+=1;g["shot_attempts"]+=r["shot_attempts"];g["sog"]+=r["shots_on_goal"];g["goals"]+=r["goals"]
            g["slot_attempts"]+=r["hoh_slot_attempts"];g["slot_sog"]+=r["hoh_slot_sog"]
            g["rebound_attempts"]+=r["rebound_attempts"];g["rebound_goals"]+=r["rebound_goals"]
            g["transition_attempts"]+=r["quick_transition_attempts"]
    out=[]
    for g in groups.values():
        n=g["games"];goals=g["goals"]
        out.append({
          "team_tri":g["team_tri"],"opponent_tri":g["opponent_tri"],"scope_key":g["scope_key"],"games":n,
          "shot_attempts_pg":g["shot_attempts"]/n,"sog_pg":g["sog"]/n,"goals_pg":goals/n,
          "hoh_slot_attempts_pg":g["slot_attempts"]/n,"hoh_slot_sog_pg":g["slot_sog"]/n,
          "rebound_attempts_pg":g["rebound_attempts"]/n,"quick_transition_attempts_pg":g["transition_attempts"]/n,
          "slot_goal_share_pct":100*g["slot_sog"]/g["sog"] if g["sog"] else None,
          "rebound_goal_share_pct":100*g["rebound_goals"]/goals if goals else None,
        })
    return out

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):return str(v)
    return "'"+str(v).replace("'","''")+"'"

TEAM_COLS=("game_pk","season_id","game_type","team_tri","opponent_tri","is_home","shot_attempts","unblocked_attempts",
"shots_on_goal","goals","hoh_slot_attempts","hoh_slot_sog","hoh_slot_goals","rebound_attempts","rebound_sog","rebound_goals",
"quick_transition_attempts","quick_transition_sog","quick_transition_goals","attempts_tied","attempts_leading","attempts_trailing",
"avg_shot_distance_ft","avg_shot_angle_deg","wrist_attempts","snap_attempts","slap_attempts","backhand_attempts","tip_attempts",
"deflected_attempts","other_attempts")
PLAYER_COLS=("game_pk","season_id","game_type","team_tri","player_id","shot_attempts","unblocked_attempts","shots_on_goal","goals",
"hoh_slot_attempts","hoh_slot_sog","hoh_slot_goals","rebound_attempts","rebound_sog","rebound_goals","quick_transition_attempts",
"quick_transition_sog","quick_transition_goals","avg_shot_distance_ft","avg_shot_angle_deg","max_shot_distance_ft")
H2H_COLS=("team_tri","opponent_tri","scope_key","games","shot_attempts_pg","sog_pg","goals_pg","hoh_slot_attempts_pg","hoh_slot_sog_pg",
"rebound_attempts_pg","quick_transition_attempts_pg","slot_goal_share_pct","rebound_goal_share_pct")

def statement(table,cols,rows,conflict):
    vals=[("(" + ",".join(q(r.get(c)) for c in cols) + ")") for r in rows]
    updates=",".join(f"{c}=excluded.{c}" for c in cols if c not in conflict)
    return f"INSERT INTO {table} ({','.join(cols)}) VALUES\n"+",\n".join(vals)+f"\nON CONFLICT({','.join(conflict)}) DO UPDATE SET {updates};\n"

def bundles(table,cols,rows,conflict,max_stmt=55000):
    out=[];cur=[];size=0
    for r in rows:
        est=sum(len(str(r.get(c))) if r.get(c) is not None else 4 for c in cols)+len(cols)*4
        if cur and (len(cur)>=180 or size+est>max_stmt):
            out.append(statement(table,cols,cur,conflict));cur=[];size=0
        cur.append(r);size+=est
    if cur:out.append(statement(table,cols,cur,conflict))
    return out

def write_sql(out_dir,team_rows,player_rows,h2h_rows):
    sql=out_dir/"sql";sql.mkdir(parents=True,exist_ok=True)
    for f in sql.glob("*.sql"):f.unlink()
    stmts=[]
    stmts+=bundles("team_shot_context_game",TEAM_COLS,team_rows,("game_pk","team_tri"))
    stmts+=bundles("player_shot_context_game",PLAYER_COLS,player_rows,("game_pk","player_id"))
    stmts+=bundles("team_shot_context_h2h",H2H_COLS,h2h_rows,("team_tri","opponent_tri","scope_key"))
    files=[];parts=[];used=0
    for s in stmts:
        b=len(s.encode())+1
        if parts and used+b>2_000_000:
            p=sql/f"shot_context_{len(files):03d}.sql";p.write_text("\n".join(parts),encoding="utf-8");files.append(p);parts=[];used=0
        parts.append(s);used+=b
    if parts:
        p=sql/f"shot_context_{len(files):03d}.sql";p.write_text("\n".join(parts),encoding="utf-8");files.append(p)
    meta=f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('shot_context.team_game_rows','{len(team_rows)}',CURRENT_TIMESTAMP),
('shot_context.player_game_rows','{len(player_rows)}',CURRENT_TIMESTAMP),
('shot_context.h2h_rows','{len(h2h_rows)}',CURRENT_TIMESTAMP),
('shot_context.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
"""
    (sql/"shot_context_meta.sql").write_text(meta,encoding="utf-8")
    return files

def main():
    a=args();games=load_games(a.games_sql);workers=max(1,min(a.workers,16))
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    team_rows=[];player_rows=[];failures=[]
    print(f"SHOT_CONTEXT games={len(games)} workers={workers}",flush=True)
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        fm={pool.submit(fetch_game,g,a.timeout,a.attempts):g for g in games}
        done=0
        for fut in cf.as_completed(fm):
            g=fm[fut];done+=1
            try:
                r=fut.result();team_rows+=r["team_rows"];player_rows+=r["player_rows"]
            except Exception as e:failures.append({"game_pk":g["game_pk"],"error":str(e)})
            if done%200==0 or done==len(games):
                print(f"SHOT_CONTEXT {done}/{len(games)} team={len(team_rows)} player={len(player_rows)} failed={len(failures)}",flush=True)
    team_rows.sort(key=lambda r:(r["game_pk"],r["team_tri"]))
    player_rows.sort(key=lambda r:(r["game_pk"],r["player_id"]))
    h2h_rows=h2h(team_rows)
    files=write_sql(out,team_rows,player_rows,h2h_rows)
    summary={"ok":not failures,"games":len(games),"failed":len(failures),"team_game_rows":len(team_rows),
      "player_game_rows":len(player_rows),"h2h_rows":len(h2h_rows),"sql_files":len(files),
      "failures":failures,"computed_at":dt.datetime.now(dt.timezone.utc).isoformat()}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k!="failures"},ensure_ascii=False),flush=True)
    if failures:raise SystemExit(2)

if __name__=="__main__":main()
