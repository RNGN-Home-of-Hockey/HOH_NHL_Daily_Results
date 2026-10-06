#!/usr/bin/env python3
"""Fetch league-wide NBA game logs and emit idempotent D1 SQL chunks."""
from __future__ import annotations

import argparse, hashlib, json, os, random, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SEASONS=["2021-22","2022-23","2023-24","2024-25","2025-26"]
SEASON_TYPES=["Regular Season","Playoffs"]
BASE=os.getenv("NBA_STATS_BASE_URL","https://stats.nba.com/stats").rstrip("/")
HEADERS={
 "Accept":"application/json, text/plain, */*","Accept-Language":"en-US,en;q=0.9","Cache-Control":"no-cache",
 "Connection":"close","Origin":"https://www.nba.com","Pragma":"no-cache","Referer":"https://www.nba.com/",
 "Sec-Ch-Ua":'"Chromium";v="140", "Google Chrome";v="140", "Not_A Brand";v="99"',"Sec-Ch-Ua-Mobile":"?0",
 "Sec-Ch-Ua-Platform":'"Windows"',"Sec-Fetch-Dest":"empty","Sec-Fetch-Mode":"cors","Sec-Fetch-Site":"same-site",
 "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
}
STATS=["MIN","FGM","FGA","FG_PCT","FG3M","FG3A","FG3_PCT","FTM","FTA","FT_PCT","OREB","DREB","REB","AST","TOV","STL","BLK","BLKA","PF","PFD","PTS","PLUS_MINUS"]

def args():
 p=argparse.ArgumentParser(); p.add_argument("--seasons",nargs="+",default=SEASONS); p.add_argument("--season-types",nargs="+",default=SEASON_TYPES)
 p.add_argument("--output-dir",default="local-data/nba"); p.add_argument("--timeout",type=int,default=60); p.add_argument("--attempts",type=int,default=6)
 p.add_argument("--request-gap",type=float,default=6); p.add_argument("--rows-per-file",type=int,default=1200); return p.parse_args()

def params(endpoint,season,stype):
 d={"DateFrom":"","DateTo":"","GameSegment":"","LastNGames":"0","LeagueID":"00","Location":"","MeasureType":"Base","Month":"0","Outcome":"","PORound":"0","PerMode":"Totals","Period":"0","PlayerID":"","Season":season,"SeasonSegment":"","SeasonType":stype,"ShotClockRange":"","TeamID":"","VsConference":"","VsDivision":""}
 d["OpponentTeamID" if endpoint=="playergamelogs" else "OppTeamID"]="0"; return d

def fetch(endpoint,p,timeout,attempts):
 url=f"{BASE}/{endpoint}?{urlencode(p)}"; last=None
 for n in range(1,attempts+1):
  try:
   with urlopen(Request(url,headers=HEADERS),timeout=timeout) as r:
    raw=r.read(); return json.loads(raw.decode()),raw
  except (HTTPError,URLError,TimeoutError,json.JSONDecodeError) as e:
   last=e
   if n==attempts: break
   delay=min(90,4*(2**(n-1)))+random.uniform(.5,2.5); print(f"WARN {endpoint} {n}/{attempts}: {e}; retry {delay:.1f}s",file=sys.stderr); time.sleep(delay)
 raise RuntimeError(f"{endpoint} failed: {last}")

def rows(payload,name):
 sets=[]
 for k in ("resultSets","resultSet"):
  v=payload.get(k)
  if isinstance(v,list): sets+=v
  elif isinstance(v,dict): sets.append(v)
 for ds in sets:
  if str(ds.get("name") or ds.get("Name") or "").lower()!=name.lower(): continue
  h=ds.get("headers") or ds.get("Headers") or []; data=ds.get("rowSet") or ds.get("data") or []
  return [dict(zip(h,r)) for r in data]
 raise RuntimeError(f"dataset {name} not found")

def date(v):
 s=str(v or "").strip().replace("Z","")
 for f in ("%Y-%m-%dT%H:%M:%S","%Y-%m-%d","%b %d, %Y","%b %d %Y","%m/%d/%Y"):
  try: return datetime.strptime(s[:19],f).date().isoformat()
  except ValueError: pass
 if re.match(r"^\d{4}-\d{2}-\d{2}",s): return s[:10]
 raise ValueError(f"bad date {v!r}")

def val(v):
 if v is None or v=="": return "NULL"
 if isinstance(v,bool): return "1" if v else "0"
 if isinstance(v,(int,float)): return str(v)
 return "'"+str(v).replace("'","''")+"'"

def insert(table,cols,data,conflict):
 if not data: return ""
 vv=["("+",".join(val(x) for x in r)+")" for r in data]
 return f"INSERT INTO {table} ({','.join(cols)}) VALUES\n"+",\n".join(vv)+f"\n{conflict};\n"

def chunks(a,n):
 for i in range(0,len(a),n): yield a[i:i+n]

def update_all(cols,keycols):
 return "ON CONFLICT("+",".join(keycols)+") DO UPDATE SET "+", ".join(f"{c}=excluded.{c}" for c in cols if c not in keycols)+", updated_at=CURRENT_TIMESTAMP"

def team_sql(raws,season,stype,chunk):
 norm=[]; latest={}; games={}
 for x in raws:
  gid=str(x.get("GAME_ID") or "").strip(); tid=int(x["TEAM_ID"]); gd=date(x.get("GAME_DATE")); matchup=str(x.get("MATCHUP") or "").strip()
  if " vs" in matchup: home=1
  elif " @ " in matchup: home=0
  else: raise ValueError(f"bad matchup {matchup}")
  r={"game_id":gid,"team_id":tid,"season_year":str(x.get("SEASON_YEAR") or season),"season_type":stype,"game_date":gd,"team_abbr":str(x.get("TEAM_ABBREVIATION") or "").strip(),"team_name":str(x.get("TEAM_NAME") or "").strip() or None,"matchup":matchup,"wl":str(x.get("WL") or "").strip() or None,"is_home":home}
  for f in STATS: r[f.lower()]=x.get(f) if x.get(f)!="" else None
  norm.append(r); games.setdefault(gid,[]).append(r)
  if tid not in latest or (gd,gid)>(latest[tid]["game_date"],latest[tid]["game_id"]): latest[tid]=r
 dimcols=["team_id","abbreviation","team_name","last_seen_game_date","last_seen_game_id"]
 dims=[[r["team_id"],r["team_abbr"],r["team_name"],r["game_date"],r["game_id"]] for r in latest.values()]
 dimconf="ON CONFLICT(team_id) DO UPDATE SET abbreviation=excluded.abbreviation,team_name=COALESCE(excluded.team_name,nba_teams.team_name),last_seen_game_date=MAX(COALESCE(nba_teams.last_seen_game_date,''),excluded.last_seen_game_date),last_seen_game_id=CASE WHEN COALESCE(nba_teams.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_teams.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_teams.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.last_seen_game_id ELSE nba_teams.last_seen_game_id END,updated_at=CURRENT_TIMESTAMP"
 grows=[]
 for gid,pair in games.items():
  home=next((r for r in pair if r["is_home"]),None); away=next((r for r in pair if not r["is_home"]),None)
  if len(pair)!=2 or not home or not away: raise RuntimeError(f"game {gid}: expected 2 sides, got {len(pair)}")
  grows.append([gid,home["season_year"],stype,home["game_date"],home["team_id"],away["team_id"],home["team_abbr"],away["team_abbr"],home["pts"],away["pts"],"FINAL"])
 gcols=["game_id","season_year","season_type","game_date","home_team_id","away_team_id","home_team_abbr","away_team_abbr","home_score","away_score","game_status"]
 tcols=["game_id","team_id","season_year","season_type","game_date","team_abbr","team_name","matchup","wl","is_home","minutes","fgm","fga","fg_pct","fg3m","fg3a","fg3_pct","ftm","fta","ft_pct","oreb","dreb","reb","ast","tov","stl","blk","blka","pf","pfd","pts","plus_minus"]
 trows=[[r["game_id"],r["team_id"],r["season_year"],r["season_type"],r["game_date"],r["team_abbr"],r["team_name"],r["matchup"],r["wl"],r["is_home"],r["min"],r["fgm"],r["fga"],r["fg_pct"],r["fg3m"],r["fg3a"],r["fg3_pct"],r["ftm"],r["fta"],r["ft_pct"],r["oreb"],r["dreb"],r["reb"],r["ast"],r["tov"],r["stl"],r["blk"],r["blka"],r["pf"],r["pfd"],r["pts"],r["plus_minus"]] for r in norm]
 sql=[insert("nba_teams",dimcols,dims,dimconf),insert("nba_games",gcols,grows,update_all(gcols,["game_id"]))]
 sql += [insert("nba_team_game_stats",tcols,c,update_all(tcols,["game_id","team_id"])) for c in chunks(trows,chunk)]
 return sql,{"games":len(grows),"team_rows":len(trows),"first_game_date":min((r["game_date"] for r in norm),default=None),"last_game_date":max((r["game_date"] for r in norm),default=None)}

def player_sql(raws,season,stype,chunk):
 norm=[]; latest={}
 for x in raws:
  gid=str(x.get("GAME_ID") or "").strip(); pid=int(x["PLAYER_ID"]); gd=date(x.get("GAME_DATE"))
  r={"game_id":gid,"player_id":pid,"season_year":str(x.get("SEASON_YEAR") or season),"season_type":stype,"game_date":gd,"player_name":str(x.get("PLAYER_NAME") or "").strip(),"team_id":int(x["TEAM_ID"]),"team_abbr":str(x.get("TEAM_ABBREVIATION") or "").strip(),"team_name":str(x.get("TEAM_NAME") or "").strip() or None,"matchup":str(x.get("MATCHUP") or "").strip(),"wl":str(x.get("WL") or "").strip() or None}
  for f in STATS: r[f.lower()]=x.get(f) if x.get(f)!="" else None
  for f in ("NBA_FANTASY_PTS","DD2","TD3"): r[f.lower()]=x.get(f) if x.get(f)!="" else None
  norm.append(r)
  if pid not in latest or (gd,gid)>(latest[pid]["game_date"],latest[pid]["game_id"]): latest[pid]=r
 dcols=["player_id","full_name","current_team_id","current_team_abbr","last_seen_game_date","last_seen_game_id"]
 drows=[[r["player_id"],r["player_name"],r["team_id"],r["team_abbr"],r["game_date"],r["game_id"]] for r in latest.values()]
 dconf="ON CONFLICT(player_id) DO UPDATE SET full_name=excluded.full_name,current_team_id=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.current_team_id ELSE nba_players.current_team_id END,current_team_abbr=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.current_team_abbr ELSE nba_players.current_team_abbr END,last_seen_game_date=MAX(COALESCE(nba_players.last_seen_game_date,''),excluded.last_seen_game_date),last_seen_game_id=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.last_seen_game_id ELSE nba_players.last_seen_game_id END,updated_at=CURRENT_TIMESTAMP"
 cols=["game_id","player_id","season_year","season_type","game_date","player_name","team_id","team_abbr","team_name","matchup","wl","minutes","fgm","fga","fg_pct","fg3m","fg3a","fg3_pct","ftm","fta","ft_pct","oreb","dreb","reb","ast","tov","stl","blk","blka","pf","pfd","pts","plus_minus","nba_fantasy_pts","dd2","td3"]
 prows=[[r["game_id"],r["player_id"],r["season_year"],r["season_type"],r["game_date"],r["player_name"],r["team_id"],r["team_abbr"],r["team_name"],r["matchup"],r["wl"],r["min"],r["fgm"],r["fga"],r["fg_pct"],r["fg3m"],r["fg3a"],r["fg3_pct"],r["ftm"],r["fta"],r["ft_pct"],r["oreb"],r["dreb"],r["reb"],r["ast"],r["tov"],r["stl"],r["blk"],r["blka"],r["pf"],r["pfd"],r["pts"],r["plus_minus"],r["nba_fantasy_pts"],r["dd2"],r["td3"]] for r in norm]
 sql=[insert("nba_players",dcols,drows,dconf)]
 sql += [insert("nba_player_game_stats",cols,c,update_all(cols,["game_id","player_id"])) for c in chunks(prows,chunk)]
 return sql,{"player_rows":len(prows)}

def slug(s): return re.sub(r"[^a-z0-9]+","-",s.lower()).strip("-")
def write_sql(root,prefix,statements):
 out=[]
 for i,s in enumerate((x for x in statements if x.strip()),1):
  p=root/f"{prefix}_{i:02d}.sql"; p.write_text("PRAGMA foreign_keys = ON;\n"+s); out.append(p)
 return out

def main():
 a=args(); root=Path(a.output_dir); rawdir=root/"raw"; sqldir=root/"sql"; rawdir.mkdir(parents=True,exist_ok=True); sqldir.mkdir(parents=True,exist_ok=True)
 summary=[]; first=True
 for season in a.seasons:
  for stype in a.season_types:
   if not first: time.sleep(a.request_gap)
   first=False; key=f"{season}_{slug(stype)}"; print(f"=== {season} / {stype} ===")
   tp,tb=fetch("teamgamelogs",params("teamgamelogs",season,stype),a.timeout,a.attempts); tr=rows(tp,"TeamGameLogs"); (rawdir/f"{key}_teamgamelogs.json").write_bytes(tb)
   time.sleep(a.request_gap)
   pp,pb=fetch("playergamelogs",params("playergamelogs",season,stype),a.timeout,a.attempts); pr=rows(pp,"PlayerGameLogs"); (rawdir/f"{key}_playergamelogs.json").write_bytes(pb)
   if not tr or not pr: raise RuntimeError(f"empty dataset {season} {stype}: teams={len(tr)} players={len(pr)}")
   ts,tm=team_sql(tr,season,stype,a.rows_per_file); ps,pm=player_sql(pr,season,stype,a.rows_per_file); files=write_sql(sqldir,key,ts+ps)
   fetched=datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
   mcols=["season_year","season_type","source","player_rows","team_rows","game_rows","first_game_date","last_game_date","player_payload_sha256","team_payload_sha256","fetched_at"]
   mrow=[[season,stype,"stats.nba.com",pm["player_rows"],tm["team_rows"],tm["games"],tm["first_game_date"],tm["last_game_date"],hashlib.sha256(pb).hexdigest(),hashlib.sha256(tb).hexdigest(),fetched]]
   msql=insert("nba_sync_manifest",mcols,mrow,update_all(mcols,["season_year","season_type"])); mp=sqldir/f"{key}_99_manifest.sql"; mp.write_text("PRAGMA foreign_keys = ON;\n"+msql); files.append(mp)
   item={"season":season,"season_type":stype,**tm,**pm,"sql_files":[str(x) for x in files]}; summary.append(item); print(json.dumps(item))
 (root/"summary.json").write_text(json.dumps(summary,indent=2)); return 0

if __name__=="__main__": raise SystemExit(main())
