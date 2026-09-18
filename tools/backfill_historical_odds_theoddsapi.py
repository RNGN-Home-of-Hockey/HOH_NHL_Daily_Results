#!/usr/bin/env python3
"""Backfill two NHL seasons of licensed closing 1-X-2 consensus from The Odds API.

Requires THE_ODDS_API_KEY. We query one historical NHL league snapshot per
unique scheduled start timestamp, EU region, h2h market. For hockey, EU
bookmakers typically feature regular-time 3-way odds. Only bookmaker markets
with exactly home/away/draw outcomes are included in the consensus.

Provider: https://the-odds-api.com/
Market contract persisted by HOH: regular_time_1x2
"""
from __future__ import annotations
import argparse,datetime as dt,json,math,os,re,time,urllib.error,urllib.parse,urllib.request
from collections import defaultdict
from pathlib import Path

BASE="https://api.the-odds-api.com/v4/historical/sports/icehockey_nhl/odds"
SRC=Path("migrations/0017_nhl_two_season_games.sql")
OUT=Path("local-data/historical-odds")
UA="HOH-Historical-Odds/1.0"
PAT=re.compile(r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',",re.M)

TEAM_NAMES={
"ANA":"Anaheim Ducks","BOS":"Boston Bruins","BUF":"Buffalo Sabres","CAR":"Carolina Hurricanes",
"CBJ":"Columbus Blue Jackets","CGY":"Calgary Flames","CHI":"Chicago Blackhawks","COL":"Colorado Avalanche",
"DAL":"Dallas Stars","DET":"Detroit Red Wings","EDM":"Edmonton Oilers","FLA":"Florida Panthers",
"LAK":"Los Angeles Kings","MIN":"Minnesota Wild","MTL":"Montreal Canadiens","NJD":"New Jersey Devils",
"NSH":"Nashville Predators","NYI":"New York Islanders","NYR":"New York Rangers","OTT":"Ottawa Senators",
"PHI":"Philadelphia Flyers","PIT":"Pittsburgh Penguins","SEA":"Seattle Kraken","SJS":"San Jose Sharks",
"STL":"St. Louis Blues","TBL":"Tampa Bay Lightning","TOR":"Toronto Maple Leafs","UTA":"Utah Hockey Club",
"VAN":"Vancouver Canucks","VGK":"Vegas Golden Knights","WPG":"Winnipeg Jets","WSH":"Washington Capitals",
}
ALIASES={"UTA":{"utah hockey club","utah mammoth"}}

def parse_args():
    p=argparse.ArgumentParser()
    p.add_argument("--source",default=str(SRC))
    p.add_argument("--out",default=str(OUT))
    p.add_argument("--offset-minutes",type=int,default=2)
    p.add_argument("--fallback-minutes",type=int,default=7)
    p.add_argument("--timeout",type=int,default=35)
    p.add_argument("--attempts",type=int,default=4)
    p.add_argument("--dry-run",action="store_true")
    return p.parse_args()

def norm(s): return re.sub(r"[^a-z0-9]","",str(s or "").lower())

def team_aliases(tri):
    names={TEAM_NAMES[tri].lower()}
    names|=ALIASES.get(tri,set())
    return {norm(x) for x in names}

def load_games(path):
    text=Path(path).read_text(encoding="utf-8");rows=[]
    for m in PAT.finditer(text):
        pk,season,gt,start,home,away=m.groups()
        rows.append({"game_pk":int(pk),"season_id":season,"game_type":int(gt),
                     "start":start,"home_tri":home,"away_tri":away})
    return rows

def iso_before(start,minutes):
    t=dt.datetime.fromisoformat(start.replace("Z","+00:00"))-dt.timedelta(minutes=minutes)
    return t.isoformat().replace("+00:00","Z")

def get_json(url,timeout,attempts):
    last=None
    for n in range(1,attempts+1):
        try:
            req=urllib.request.Request(url,headers={"Accept":"application/json","User-Agent":UA})
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return json.load(r),dict(r.headers)
        except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,json.JSONDecodeError) as e:
            last=e
            if isinstance(e,urllib.error.HTTPError) and e.code not in {408,425,429,500,502,503,504}: raise
            if n<attempts:time.sleep(min(8,.7*(2**(n-1))))
    raise RuntimeError(str(last))

def query_snapshot(api_key,when,timeout,attempts):
    params=urllib.parse.urlencode({
      "apiKey":api_key,"regions":"eu","markets":"h2h","oddsFormat":"decimal","date":when
    })
    return get_json(BASE+"?"+params,timeout,attempts)

def event_list(payload):
    if isinstance(payload,list): return payload
    if isinstance(payload,dict):
        data=payload.get("data")
        return data if isinstance(data,list) else []
    return []

def match_event(events,game):
    ha=team_aliases(game["home_tri"]);aa=team_aliases(game["away_tri"])
    for ev in events:
        if norm(ev.get("home_team")) in ha and norm(ev.get("away_team")) in aa:
            return ev
    return None

def prices_for_book(book,event,game):
    markets=book.get("markets") or []
    for market in markets:
        if market.get("key")!="h2h": continue
        outcomes=market.get("outcomes") or []
        home=away=draw=None
        ha=team_aliases(game["home_tri"]);aa=team_aliases(game["away_tri"])
        for o in outcomes:
            name=norm(o.get("name"));price=o.get("price")
            try: price=float(price)
            except (TypeError,ValueError): continue
            if price<=1: continue
            if name in ha:home=price
            elif name in aa:away=price
            elif name in {"draw","tie"}:draw=price
        if home and away and draw:
            return home,draw,away
    return None

def consensus(event,game):
    books=[]
    for b in event.get("bookmakers") or []:
        p=prices_for_book(b,event,game)
        if not p: continue
        h,d,a=p
        raw=[1/h,1/d,1/a];total=sum(raw)
        books.append({
          "key":b.get("key"),"title":b.get("title"),"last_update":b.get("last_update"),
          "home":h,"draw":d,"away":a,
          "home_nv":raw[0]/total,"draw_nv":raw[1]/total,"away_nv":raw[2]/total,
          "overround":total-1,
        })
    if not books:return None
    avg=lambda k:sum(x[k] for x in books)/len(books)
    h,d,a=avg("home"),avg("draw"),avg("away")
    implied=[1/h,1/d,1/a];s=sum(implied)
    return {
      "home_odds":h,"draw_odds":d,"away_odds":a,"bookmaker_count":len(books),
      "home_implied_prob":implied[0],"draw_implied_prob":implied[1],"away_implied_prob":implied[2],
      "home_no_vig_prob":avg("home_nv"),"draw_no_vig_prob":avg("draw_nv"),"away_no_vig_prob":avg("away_nv"),
      "overround_pct":100*avg("overround"),
      "books":[{"key":x["key"],"home":x["home"],"draw":x["draw"],"away":x["away"],"last_update":x["last_update"]} for x in books],
    }

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):
        if isinstance(v,float) and (math.isnan(v) or math.isinf(v)):return "NULL"
        return repr(v)
    return "'"+str(v).replace("'","''")+"'"

COLS=("game_pk","source","market_key","captured_at","source_event_id","home_odds","draw_odds","away_odds",
"bookmaker_count","home_implied_prob","draw_implied_prob","away_implied_prob","home_no_vig_prob",
"draw_no_vig_prob","away_no_vig_prob","overround_pct","raw_summary_json")

def make_sql(rows,out):
    vals=[]
    for r in rows:
        vals.append("(" + ",".join(q(r.get(c)) for c in COLS) + ")")
    statements=[];cur=[];used=0
    header="INSERT INTO historical_odds_closing ("+",".join(COLS)+") VALUES\n"
    tail="""\nON CONFLICT(game_pk,source,market_key) DO UPDATE SET
captured_at=excluded.captured_at,source_event_id=excluded.source_event_id,
home_odds=excluded.home_odds,draw_odds=excluded.draw_odds,away_odds=excluded.away_odds,
bookmaker_count=excluded.bookmaker_count,home_implied_prob=excluded.home_implied_prob,
draw_implied_prob=excluded.draw_implied_prob,away_implied_prob=excluded.away_implied_prob,
home_no_vig_prob=excluded.home_no_vig_prob,draw_no_vig_prob=excluded.draw_no_vig_prob,
away_no_vig_prob=excluded.away_no_vig_prob,overround_pct=excluded.overround_pct,
raw_summary_json=excluded.raw_summary_json,updated_at=CURRENT_TIMESTAMP;"""
    for v in vals:
        b=len(v.encode())+2
        if cur and (len(cur)>=100 or used+b>55000):
            statements.append(header+",\n".join(cur)+tail);cur=[];used=0
        cur.append(v);used+=b
    if cur:statements.append(header+",\n".join(cur)+tail)
    statements.append(f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('historical_odds.rows','{len(rows)}',CURRENT_TIMESTAMP),
('historical_odds.source','the_odds_api_eu_consensus',CURRENT_TIMESTAMP),
('historical_odds.market','regular_time_1x2',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;""")
    out.write_text("\n".join(statements),encoding="utf-8")

def main():
    a=parse_args();games=load_games(a.source)
    groups=defaultdict(list)
    for g in games:groups[g["start"]].append(g)
    estimate={"games":len(games),"unique_start_timestamps":len(groups),"estimated_credits":len(groups)*10}
    print("ESTIMATE "+json.dumps(estimate),flush=True)
    if a.dry_run:return
    key=os.environ.get("THE_ODDS_API_KEY","").strip()
    if not key:raise SystemExit("Missing THE_ODDS_API_KEY")
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    rows=[];missing=[];fallback_calls=0;used=remaining=None
    for i,(start,batch) in enumerate(sorted(groups.items()),1):
        requested=iso_before(start,a.offset_minutes)
        payload,headers=query_snapshot(key,requested,a.timeout,a.attempts)
        used=headers.get("x-requests-used",used);remaining=headers.get("x-requests-remaining",remaining)
        events=event_list(payload)
        unresolved=[]
        for g in batch:
            ev=match_event(events,g);c=consensus(ev,g) if ev else None
            if c:
                rows.append({
                  "game_pk":g["game_pk"],"source":"the_odds_api_eu_consensus","market_key":"regular_time_1x2",
                  "captured_at":requested,"source_event_id":ev.get("id"),
                  **{k:c[k] for k in c if k!="books"},
                  "raw_summary_json":json.dumps({"books":c["books"]},ensure_ascii=False,separators=(",",":"))
                })
            else:unresolved.append(g)
        if unresolved:
            fallback=iso_before(start,a.fallback_minutes)
            payload2,headers2=query_snapshot(key,fallback,a.timeout,a.attempts);fallback_calls+=1
            used=headers2.get("x-requests-used",used);remaining=headers2.get("x-requests-remaining",remaining)
            events2=event_list(payload2)
            for g in unresolved:
                ev=match_event(events2,g);c=consensus(ev,g) if ev else None
                if c:
                    rows.append({
                      "game_pk":g["game_pk"],"source":"the_odds_api_eu_consensus","market_key":"regular_time_1x2",
                      "captured_at":fallback,"source_event_id":ev.get("id"),
                      **{k:c[k] for k in c if k!="books"},
                      "raw_summary_json":json.dumps({"books":c["books"]},ensure_ascii=False,separators=(",",":"))
                    })
                else:missing.append(g)
        if i%100==0 or i==len(groups):
            print(f"ODDS {i}/{len(groups)} rows={len(rows)} missing={len(missing)} fallback_calls={fallback_calls} used={used} remaining={remaining}",flush=True)
    rows.sort(key=lambda r:r["game_pk"])
    make_sql(rows,out/"historical_odds.sql")
    summary={"ok":len(rows)>0,"games":len(games),"rows":len(rows),"missing":len(missing),
             "unique_start_timestamps":len(groups),"fallback_calls":fallback_calls,
             "requests_used_header":used,"requests_remaining_header":remaining,
             "missing_games":missing}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k!="missing_games"},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
