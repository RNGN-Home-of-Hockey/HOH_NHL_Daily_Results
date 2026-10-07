#!/usr/bin/env python3
"""Backfill NBA seasons from ESPN box scores while preserving official NBA player/team IDs.

Used only where the legacy data.nba.com game-detail archive is incomplete/stale.
Official NBA player directory and schedule are used for canonical IDs whenever available.
"""
from __future__ import annotations

import argparse, concurrent.futures, gzip, hashlib, json, math, random, re, time, unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

NBA_SCHEDULE = "https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/{year}/league/00_full_schedule.json"
NBA_PLAYERS = "https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/{year}/players/00_player_info.json"
ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={day}"
ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={event_id}"
SOURCE = "espn+data.nba.com-player-directory"
HEADERS = {"Accept":"application/json","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"}
GAME_TYPE = {"001":"Preseason","002":"Regular Season","004":"Playoffs","005":"Play-In","006":"NBA Cup Final"}

def args():
    p=argparse.ArgumentParser(); p.add_argument("--seasons",nargs="+",required=True); p.add_argument("--output-dir",required=True)
    p.add_argument("--workers",type=int,default=12); p.add_argument("--timeout",type=int,default=30); p.add_argument("--attempts",type=int,default=5)
    p.add_argument("--statement-rows",type=int,default=150); p.add_argument("--statements-per-file",type=int,default=50); p.add_argument("--allow-failures",type=int,default=0)
    return p.parse_args()

def fetch_bytes(url,timeout,attempts):
    last=None
    for i in range(1,attempts+1):
        try:
            with urlopen(Request(url,headers=HEADERS),timeout=timeout) as r: return r.read()
        except (HTTPError,URLError,TimeoutError,OSError) as e:
            last=e
            if i==attempts: break
            time.sleep(min(12,.7*(2**(i-1)))+random.uniform(.1,.6))
    raise RuntimeError(f"fetch failed {url}: {last}")

def fetch_json(url,timeout,attempts):
    raw=fetch_bytes(url,timeout,attempts); return json.loads(raw.decode("utf-8-sig")),raw

def canon(s):
    s=unicodedata.normalize("NFKD",str(s or "")); s="".join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r"\b(jr|sr|ii|iii|iv|v)\b","",s); return re.sub(r"[^a-z0-9]","",s)

def official_directory(payload):
    rows=((payload.get("pls") or {}).get("pl") or []); by_name={}; teams={}
    for p in rows:
        name=" ".join(x for x in (str(p.get("fn") or "").strip(),str(p.get("ln") or "").strip()) if x); k=canon(name)
        if k: by_name.setdefault(k,[]).append(p)
        ta=str(p.get("ta") or "").upper()
        if ta and p.get("tid"): teams[ta]=int(p["tid"])
    return rows,by_name,teams

def official_schedule(payload):
    out=[]
    for block in payload.get("lscd") or []:
        for g in (block.get("mscd") or {}).get("g") or []:
            gid=str(g.get("gid") or "")
            if len(gid)!=10 or gid[:3] not in {"002","004","005","006"}: continue
            gd=str(g.get("gdte") or g.get("gdtutc") or "")[:10]; h=g.get("h") or {}; v=g.get("v") or {}; ha=str(h.get("ta") or "").upper(); va=str(v.get("ta") or "").upper()
            if gd and ha and va: out.append({"game_id":gid,"game_date":gd,"home_abbr":ha,"away_abbr":va,"season_type":GAME_TYPE.get(gid[:3],gid[:3])})
    return out

def daterange(start,end):
    while start<=end: yield start; start+=timedelta(days=1)

def season_bounds(season,official_rows):
    y=int(season[:4]); starts=[date.fromisoformat(r["game_date"]) for r in official_rows if r["season_type"]=="Regular Season"]
    return (min(starts) if starts else date(y,10,15)),date(y+1,6,30)

def scoreboard_events(season,official_rows,team_ids,timeout,attempts,workers):
    start,end=season_bounds(season,official_rows); days=list(daterange(start,end)); found={}; failures=[]; raws=[]
    def job(d):
        try: p,raw=fetch_json(ESPN_SCOREBOARD.format(day=d.strftime("%Y%m%d")),timeout,attempts); return d,p,raw,None
        except Exception as e:return d,None,None,str(e)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers,16)) as ex:
        futs=[ex.submit(job,d) for d in days]; done=0
        for f in concurrent.futures.as_completed(futs):
            d,p,raw,err=f.result(); done+=1
            if err: failures.append({"date":d.isoformat(),"error":err}); continue
            raws.append((d,raw))
            for e in p.get("events") or []:
                if (((e.get("status") or {}).get("type") or {}).get("state"))!="post": continue
                home,away,_=competitors(e); ha=str((home.get("team") or {}).get("abbreviation") or "").upper(); aa=str((away.get("team") or {}).get("abbreviation") or "").upper()
                if ha in team_ids and aa in team_ids: found[str(e.get("id"))]=(d,e)
            if done%50==0 or done==len(futs): print(f"{season}: scoreboard {done}/{len(futs)}",flush=True)
    h=hashlib.sha256()
    for d,raw in sorted(raws,key=lambda x:x[0]): h.update(d.isoformat().encode()); h.update(b"\0"); h.update(raw); h.update(b"\n")
    return found,failures,h.hexdigest()

def competitors(event):
    comp=(event.get("competitions") or [{}])[0]; home=away=None
    for c in comp.get("competitors") or []:
        if c.get("homeAway")=="home": home=c
        elif c.get("homeAway")=="away": away=c
    return home or {},away or {},comp

def event_key(local_date,event):
    h,a,_=competitors(event); return (local_date.isoformat(),str((h.get("team") or {}).get("abbreviation") or "").upper(),str((a.get("team") or {}).get("abbreviation") or "").upper())

def choose_game_id(local_date,event,official_by_key):
    r=official_by_key.get(event_key(local_date,event)); return (r["game_id"],r["season_type"]) if r else (f"espn:{event.get('id')}",None)

def classify_type(local_date,event,official_type):
    if official_type:return official_type
    text=(str(event.get("name") or "")+" "+" ".join(str((n or {}).get("headline") or "") for n in ((event.get("competitions") or [{}])[0].get("notes") or []))).lower()
    if "nba cup" in text and ("final" in text or "championship" in text): return "NBA Cup Final"
    if local_date.month==4 and 14<=local_date.day<=18:return "Play-In"
    if local_date.month in (5,6) or (local_date.month==4 and local_date.day>=19):return "Playoffs"
    return "Regular Season"

def n(v,integer=False):
    if v in (None,"","--"):return None
    try:
        x=float(str(v).replace("+","")); return None if not math.isfinite(x) else (int(round(x)) if integer else x)
    except:return None

def split_ma(v):
    s=str(v or "")
    if "-" not in s:return None,None
    a,b=s.split("-",1); return n(a,True),n(b,True)

def pct(m,a): return None if a in (None,0) or m is None else m/a

def map_player(name,abbr,by_name):
    c=by_name.get(canon(name),[])
    if len(c)==1:return c[0]
    same=[p for p in c if str(p.get("ta") or "").upper()==abbr]
    if len(same)==1:return same[0]
    return c[0] if c else None

def parse_summary(season,local_date,event,payload,official_by_key,by_name,team_ids):
    game_id,official_type=choose_game_id(local_date,event,official_by_key); stype=classify_type(local_date,event,official_type); hc,ac,_=competitors(event)
    ha=str((hc.get("team") or {}).get("abbreviation") or "").upper(); aa=str((ac.get("team") or {}).get("abbreviation") or "").upper(); hs=n(hc.get("score"),True); ass=n(ac.get("score"),True)
    if not ha or not aa or hs is None or ass is None:raise ValueError("missing scoreboard teams/scores")
    if ha not in team_ids or aa not in team_ids:raise ValueError(f"unmapped team {ha}/{aa}")
    ht,at=team_ids[ha],team_ids[aa]; gd=local_date.isoformat(); games=[[game_id,season,stype,gd,ht,at,ha,aa,hs,ass,"FINAL"]]
    teams=[[ht,ha,str((hc.get("team") or {}).get("displayName") or ha),gd,game_id],[at,aa,str((ac.get("team") or {}).get("displayName") or aa),gd,game_id]]
    groups=(payload.get("boxscore") or {}).get("players") or []
    if len(groups)<2:raise ValueError("summary missing player groups")
    pfacts=[];pdims=[];teamrows=[];byteam={}
    for group in groups:
        team=group.get("team") or {}; abbr=str(team.get("abbreviation") or "").upper()
        if abbr not in (ha,aa):continue
        sgs=group.get("statistics") or []
        if not sgs:continue
        sg=sgs[0]; labels=[str(x) for x in (sg.get("labels") or sg.get("names") or [])]; idx={x:i for i,x in enumerate(labels)}; rows=[]
        for item in sg.get("athletes") or []:
            if item.get("didNotPlay"):continue
            ath=item.get("athlete") or {}; name=str(ath.get("displayName") or "").strip(); vals=item.get("stats") or []
            def get(k): i=idx.get(k); return vals[i] if i is not None and i<len(vals) else None
            mins=n(get("MIN"))
            if mins is None or mins<=0:continue
            op=map_player(name,abbr,by_name)
            if not op:raise ValueError(f"unmapped player {abbr}: {name}")
            pid=int(op["pid"]);tid=team_ids[abbr];fgm,fga=split_ma(get("FG"));tpm,tpa=split_ma(get("3PT"));ftm,fta=split_ma(get("FT"))
            pts=n(get("PTS"),True) or 0;reb=n(get("REB"),True) or 0;ast=n(get("AST"),True) or 0;tov=n(get("TO"),True) or 0;stl=n(get("STL"),True) or 0;blk=n(get("BLK"),True) or 0
            oreb=n(get("OREB"),True);dreb=n(get("DREB"),True);pf=n(get("PF"),True);pm=n(get("+/-"));cats=sum(1 for x in (pts,reb,ast,stl,blk) if x>=10);fantasy=pts+1.2*reb+1.5*ast+3*stl+3*blk-tov
            ih=abbr==ha;opp=aa if ih else ha;match=f"{abbr} vs. {opp}" if ih else f"{abbr} @ {opp}";wl="W" if ((ih and hs>ass) or ((not ih) and ass>hs)) else "L";tn=str(team.get("displayName") or abbr)
            pdims.append([pid,name,tid,abbr,gd,game_id]);row=[game_id,pid,season,stype,gd,name,tid,abbr,tn,match,wl,mins,fgm,fga,pct(fgm,fga),tpm,tpa,pct(tpm,tpa),ftm,fta,pct(ftm,fta),oreb,dreb,reb,ast,tov,stl,blk,None,pf,None,pts,pm,round(fantasy,3),1 if cats>=2 else 0,1 if cats>=3 else 0]
            pfacts.append(row);rows.append(row)
        byteam[abbr]=rows
    if ha not in byteam or aa not in byteam:raise ValueError("missing parsed team player group")
    for abbr,score,opp_score,ih in ((ha,hs,ass,1),(aa,ass,hs,0)):
        rows=byteam[abbr];tid=team_ids[abbr];opp=aa if ih else ha
        def sm(i):return sum((r[i] or 0) for r in rows)
        mins=sm(11);fgm=sm(12);fga=sm(13);tpm=sm(15);tpa=sm(16);ftm=sm(18);fta=sm(19);match=f"{abbr} vs. {opp}" if ih else f"{abbr} @ {opp}";wl="W" if score>opp_score else "L";tn=next((t[2] for t in teams if t[1]==abbr),abbr)
        teamrows.append([game_id,tid,season,stype,gd,abbr,tn,match,wl,ih,mins,fgm,fga,pct(fgm,fga),tpm,tpa,pct(tpm,tpa),ftm,fta,pct(ftm,fta),sm(21),sm(22),sm(23),sm(24),sm(25),sm(26),sm(27),None,sm(29),None,score,score-opp_score])
    return teams,games,teamrows,pdims,pfacts

def sqlval(v):
    if v is None:return "NULL"
    if isinstance(v,bool):return "1" if v else "0"
    if isinstance(v,(int,float)):return repr(v)
    return "'"+str(v).replace("'","''")+"'"
def chunks(a,n):
    for i in range(0,len(a),n):yield a[i:i+n]
def insert(table,cols,rows,conflict):
    if not rows:return ""
    return f"INSERT INTO {table} ({','.join(cols)}) VALUES\n"+",\n".join("("+",".join(sqlval(x) for x in r)+")" for r in rows)+f"\n{conflict};\n"
def upsert_all(cols,keys):return "ON CONFLICT("+",".join(keys)+") DO UPDATE SET "+", ".join(f"{c}=excluded.{c}" for c in cols if c not in keys)+", updated_at=CURRENT_TIMESTAMP"
def dedupe_latest(rows,key,di,gi):
    d={}
    for r in rows:
        if r[key] not in d or (r[di],r[gi])>(d[r[key]][di],d[r[key]][gi]):d[r[key]]=r
    return list(d.values())
def statements(teams,games,tfs,pds,pfs,manifest,nrows):
    tc=["team_id","abbreviation","team_name","last_seen_game_date","last_seen_game_id"];tconf="ON CONFLICT(team_id) DO UPDATE SET abbreviation=excluded.abbreviation,team_name=COALESCE(excluded.team_name,nba_teams.team_name),last_seen_game_date=CASE WHEN COALESCE(nba_teams.last_seen_game_date,'')<=excluded.last_seen_game_date THEN excluded.last_seen_game_date ELSE nba_teams.last_seen_game_date END,last_seen_game_id=CASE WHEN COALESCE(nba_teams.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_teams.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_teams.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.last_seen_game_id ELSE nba_teams.last_seen_game_id END,updated_at=CURRENT_TIMESTAMP"
    gc=["game_id","season_year","season_type","game_date","home_team_id","away_team_id","home_team_abbr","away_team_abbr","home_score","away_score","game_status"]
    tgc=["game_id","team_id","season_year","season_type","game_date","team_abbr","team_name","matchup","wl","is_home","minutes","fgm","fga","fg_pct","fg3m","fg3a","fg3_pct","ftm","fta","ft_pct","oreb","dreb","reb","ast","tov","stl","blk","blka","pf","pfd","pts","plus_minus"]
    pdc=["player_id","full_name","current_team_id","current_team_abbr","last_seen_game_date","last_seen_game_id"];pdconf="ON CONFLICT(player_id) DO UPDATE SET full_name=excluded.full_name,current_team_id=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.current_team_id ELSE nba_players.current_team_id END,current_team_abbr=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.current_team_abbr ELSE nba_players.current_team_abbr END,last_seen_game_date=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<=excluded.last_seen_game_date THEN excluded.last_seen_game_date ELSE nba_players.last_seen_game_date END,last_seen_game_id=CASE WHEN COALESCE(nba_players.last_seen_game_date,'')<excluded.last_seen_game_date OR (nba_players.last_seen_game_date=excluded.last_seen_game_date AND COALESCE(nba_players.last_seen_game_id,'')<excluded.last_seen_game_id) THEN excluded.last_seen_game_id ELSE nba_players.last_seen_game_id END,updated_at=CURRENT_TIMESTAMP"
    pgc=["game_id","player_id","season_year","season_type","game_date","player_name","team_id","team_abbr","team_name","matchup","wl","minutes","fgm","fga","fg_pct","fg3m","fg3a","fg3_pct","ftm","fta","ft_pct","oreb","dreb","reb","ast","tov","stl","blk","blka","pf","pfd","pts","plus_minus","nba_fantasy_pts","dd2","td3"];out=[]
    for c in chunks(dedupe_latest(teams,0,3,4),nrows):out.append(insert("nba_teams",tc,c,tconf))
    for c in chunks(games,nrows):out.append(insert("nba_games",gc,c,upsert_all(gc,["game_id"])))
    for c in chunks(tfs,nrows):out.append(insert("nba_team_game_stats",tgc,c,upsert_all(tgc,["game_id","team_id"])))
    for c in chunks(dedupe_latest(pds,0,4,5),nrows):out.append(insert("nba_players",pdc,c,pdconf))
    for c in chunks(pfs,nrows):out.append(insert("nba_player_game_stats",pgc,c,upsert_all(pgc,["game_id","player_id"])))
    mc=["season_year","season_type","source","player_rows","team_rows","game_rows","first_game_date","last_game_date","player_payload_sha256","team_payload_sha256","fetched_at","schedule_payload_sha256","boxscore_payload_sha256","failed_game_count"]
    for m in manifest:out.append(insert("nba_sync_manifest",mc,[m],upsert_all(mc,["season_year","season_type"])))
    return out
def write_sql(sql,season,stmts,perfile):
    clean=[x for x in stmts if x.strip()];files=[]
    for i,g in enumerate(chunks(clean,perfile),1):
        p=sql/f"nba_espn_{season.replace('-','')}_{i:03d}.sql";p.write_text("PRAGMA foreign_keys = ON;\n"+"\n".join(g),encoding="utf-8");files.append(p)
    return files

def main():
    a=args();root=Path(a.output_dir);raw=root/"raw";sql=root/"sql";raw.mkdir(parents=True,exist_ok=True);sql.mkdir(parents=True,exist_ok=True)
    for f in sql.glob("*.sql"):f.unlink()
    summary=[];total=0
    for season in a.seasons:
        y=season[:4];pp,pr=fetch_json(NBA_PLAYERS.format(year=y),a.timeout,a.attempts);sp,sr=fetch_json(NBA_SCHEDULE.format(year=y),a.timeout,a.attempts);(raw/f"players_{season}.json").write_bytes(pr);(raw/f"schedule_{season}.json").write_bytes(sr)
        _,by_name,team_ids=official_directory(pp);off=official_schedule(sp);off_by={(r["game_date"],r["home_abbr"],r["away_abbr"]):r for r in off};events,dayfail,score_sha=scoreboard_events(season,off,team_ids,a.timeout,a.attempts,a.workers)
        if dayfail:raise RuntimeError(f"{season}: scoreboard date failures={len(dayfail)}")
        print(f"{season}: ESPN completed events={len(events)}, official schedule rows={len(off)}",flush=True)
        teams=[];games=[];tfs=[];pds=[];pfs=[];fail=[];h=hashlib.sha256();results={}
        def job(it):
            eid,(d,e)=it
            try:p,rb=fetch_json(ESPN_SUMMARY.format(event_id=eid),a.timeout,a.attempts);return eid,d,e,p,rb,None
            except Exception as ex:return eid,d,e,None,None,str(ex)
        with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
            futs=[ex.submit(job,it) for it in events.items()];done=0
            for f in concurrent.futures.as_completed(futs):r=f.result();results[r[0]]=r;done+=1;print(f"{season}: summaries {done}/{len(futs)}",flush=True) if (done%100==0 or done==len(futs)) else None
        with gzip.open(raw/f"espn_summaries_{season}.jsonl.gz","wt",encoding="utf-8") as gz:
            for eid in sorted(results,key=lambda x:(results[x][1],x)):
                _,d,e,p,rb,err=results[eid]
                if err:fail.append({"event_id":eid,"date":d.isoformat(),"error":err});continue
                h.update(eid.encode());h.update(b"\0");h.update(rb);h.update(b"\n")
                try:tt,gg,tf,pd,pf=parse_summary(season,d,e,p,off_by,by_name,team_ids);teams+=tt;games+=gg;tfs+=tf;pds+=pd;pfs+=pf;gz.write(json.dumps(p,separators=(",",":"),ensure_ascii=False)+"\n")
                except Exception as er:fail.append({"event_id":eid,"date":d.isoformat(),"error":f"normalize: {er}"})
        total+=len(fail)
        if fail:(raw/f"failures_{season}.json").write_text(json.dumps(fail,indent=2,ensure_ascii=False),encoding="utf-8")
        now=datetime.now(timezone.utc).isoformat();man=[]
        for st in sorted({g[2] for g in games}):
            gs=[g for g in games if g[2]==st];ids={g[0] for g in gs};tf=[r for r in tfs if r[0] in ids];pf=[r for r in pfs if r[0] in ids];ds=[g[3] for g in gs];man.append([season,st,SOURCE,len(pf),len(tf),len(gs),min(ds),max(ds),hashlib.sha256(pr).hexdigest(),None,now,hashlib.sha256(sr).hexdigest(),h.hexdigest(),0]);summary.append({"season":season,"season_type":st,"games":len(gs),"team_rows":len(tf),"player_rows":len(pf),"failed_games":0})
        files=write_sql(sql,season,statements(teams,games,tfs,pds,pfs,man,a.statement_rows),a.statements_per_file);print(f"{season}: games={len(games)} team_rows={len(tfs)} player_rows={len(pfs)} failures={len(fail)} sql_files={len(files)}",flush=True)
    out={"generated_at":datetime.now(timezone.utc).isoformat(),"source":SOURCE,"rows":summary,"total_failures":total};(root/"summary.json").write_text(json.dumps(out,indent=2,ensure_ascii=False),encoding="utf-8")
    if total>a.allow_failures:raise RuntimeError(f"ESPN NBA backfill had {total} failures; allowed={a.allow_failures}")
    print(json.dumps(out,indent=2),flush=True)
if __name__=="__main__":main()
