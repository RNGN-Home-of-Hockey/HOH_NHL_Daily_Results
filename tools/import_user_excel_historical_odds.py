#!/usr/bin/env python3
from __future__ import annotations
import base64,csv,datetime as dt,gzip,io,json,math,re
from pathlib import Path

PAYLOAD_DIR = Path("data/historical-odds")
SOURCE="user_excel_consensus_2seasons"
MARKET="regular_time_1x2"
GAME_SQL=Path("migrations/0017_nhl_two_season_games.sql")
OUT=Path("local-data/historical-odds-user")
GAME_RE=re.compile(r"^\s*\((\d+),'(20\d{6})',([23]),'([^']+)','[^']+','([A-Z]+)','([A-Z]+)',(\d+),(\d+)\)",re.M)

TEAM={
"Anaheim Ducks":"ANA","Boston Bruins":"BOS","Buffalo Sabres":"BUF","Calgary Flames":"CGY",
"Carolina Hurricanes":"CAR","Chicago Blackhawks":"CHI","Colorado Avalanche":"COL","Columbus Blue Jackets":"CBJ",
"Dallas Stars":"DAL","Detroit Red Wings":"DET","Edmonton Oilers":"EDM","Florida Panthers":"FLA",
"Los Angeles Kings":"LAK","Minnesota Wild":"MIN","Montreal Canadiens":"MTL","Nashville Predators":"NSH",
"New Jersey Devils":"NJD","New York Islanders":"NYI","New York Rangers":"NYR","Ottawa Senators":"OTT",
"Philadelphia Flyers":"PHI","Pittsburgh Penguins":"PIT","San Jose Sharks":"SJS","Seattle Kraken":"SEA",
"St. Louis Blues":"STL","Tampa Bay Lightning":"TBL","Toronto Maple Leafs":"TOR","Utah Mammoth":"UTA",
"Vancouver Canucks":"VAN","Vegas Golden Knights":"VGK","Washington Capitals":"WSH","Winnipeg Jets":"WPG"
}

def load_source():
    parts=sorted(PAYLOAD_DIR.glob("user_payload_*.b64"))
    if not parts:
        raise RuntimeError("historical odds payload chunks not found")
    blob="".join(p.read_text(encoding="utf-8").strip() for p in parts)
    raw=gzip.decompress(base64.b64decode(blob)).decode("utf-8")
    rows=list(csv.DictReader(io.StringIO(raw)))
    print(f"PAYLOAD chunks={len(parts)} b64={len(blob)} rows={len(rows)}",flush=True)
    return rows

def load_games():
    text=GAME_SQL.read_text(encoding="utf-8")
    out=[]
    for m in GAME_RE.finditer(text):
        pk,season,gt,start,home,away,hs,as_=m.groups()
        out.append({
          "game_pk":int(pk),"season_id":season,"game_type":int(gt),"start":start,
          "utc_date":dt.date.fromisoformat(start[:10]),"home_tri":home,"away_tri":away,
          "home_score":int(hs),"away_score":int(as_)
        })
    return out

def match_rows(src,games):
    index={}
    for g in games:
        key=(g["home_tri"],g["away_tri"],g["home_score"],g["away_score"])
        index.setdefault(key,[]).append(g)
    matched=[];missing=[];ambiguous=[]
    used=set()
    for row in src:
        home=TEAM.get(row["home"]);away=TEAM.get(row["away"])
        hs,as_=map(int,row["score"].split()[0].split(":"))
        local_date=dt.date.fromisoformat(row["date"])
        candidates=[]
        for g in index.get((home,away,hs,as_),[]):
            dd=abs((g["utc_date"]-local_date).days)
            if dd<=1:
                candidates.append((dd,g))
        candidates.sort(key=lambda x:(x[0],x[1]["game_pk"]))
        candidates=[x for x in candidates if x[1]["game_pk"] not in used]
        if not candidates:
            missing.append(row);continue
        best_dd=candidates[0][0]
        best=[g for dd,g in candidates if dd==best_dd]
        if len(best)!=1:
            ambiguous.append({"source":row,"candidates":[g["game_pk"] for g in best]});continue
        g=best[0];used.add(g["game_pk"])
        o1=float(row["odd1"]);ox=float(row["oddx"]);o2=float(row["odd2"])
        implied=[1/o1,1/ox,1/o2];total=sum(implied)
        matched.append({
          "game_pk":g["game_pk"],"source":SOURCE,"market_key":MARKET,
          "captured_at":None,"source_event_id":None,
          "home_odds":o1,"draw_odds":ox,"away_odds":o2,"bookmaker_count":None,
          "home_implied_prob":implied[0],"draw_implied_prob":implied[1],"away_implied_prob":implied[2],
          "home_no_vig_prob":implied[0]/total,"draw_no_vig_prob":implied[1]/total,"away_no_vig_prob":implied[2]/total,
          "overround_pct":100*(total-1),
          "raw_summary_json":json.dumps({
             "source_file":"КЭФЫ 2 сезона.xlsx","source_date":row["date"],"source_score":row["score"],
             "source_result":row["result"],"source_home":row["home"],"source_away":row["away"]
          },ensure_ascii=False,separators=(",",":"))
        })
    return matched,missing,ambiguous,used

def q(v):
    if v is None:return "NULL"
    if isinstance(v,(int,float)) and not isinstance(v,bool):
        if isinstance(v,float) and (math.isnan(v) or math.isinf(v)):return "NULL"
        return repr(v)
    return "'"+str(v).replace("'","''")+"'"

COLS=("game_pk","source","market_key","captured_at","source_event_id","home_odds","draw_odds","away_odds",
"bookmaker_count","home_implied_prob","draw_implied_prob","away_implied_prob","home_no_vig_prob",
"draw_no_vig_prob","away_no_vig_prob","overround_pct","raw_summary_json")

def write_sql(rows):
    OUT.mkdir(parents=True,exist_ok=True)
    statements=[f"DELETE FROM historical_odds_closing WHERE source={q(SOURCE)} AND market_key={q(MARKET)};"]
    values=[]
    for r in rows:
        values.append("(" + ",".join(q(r.get(c)) for c in COLS) + ")")
    head="INSERT INTO historical_odds_closing ("+",".join(COLS)+") VALUES\n"
    tail="""\nON CONFLICT(game_pk,source,market_key) DO UPDATE SET
home_odds=excluded.home_odds,draw_odds=excluded.draw_odds,away_odds=excluded.away_odds,
home_implied_prob=excluded.home_implied_prob,draw_implied_prob=excluded.draw_implied_prob,
away_implied_prob=excluded.away_implied_prob,home_no_vig_prob=excluded.home_no_vig_prob,
draw_no_vig_prob=excluded.draw_no_vig_prob,away_no_vig_prob=excluded.away_no_vig_prob,
overround_pct=excluded.overround_pct,raw_summary_json=excluded.raw_summary_json,updated_at=CURRENT_TIMESTAMP;"""
    cur=[];used=0
    for v in values:
        b=len(v.encode("utf-8"))+2
        if cur and (len(cur)>=90 or used+b>55000):
            statements.append(head+",\n".join(cur)+tail);cur=[];used=0
        cur.append(v);used+=b
    if cur:statements.append(head+",\n".join(cur)+tail)
    statements.append(f"""INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES
('historical_odds.user_excel.rows','{len(rows)}',CURRENT_TIMESTAMP),
('historical_odds.user_excel.source_file','КЭФЫ 2 сезона.xlsx',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;""")
    (OUT/"historical_odds_user.sql").write_text("\n".join(statements),encoding="utf-8")

def main():
    src=load_source();games=load_games()
    matched,missing,ambiguous,used=match_rows(src,games)
    result_counts={}
    for r in src: result_counts[r["result"]]=result_counts.get(r["result"],0)+1
    summary={
      "source_rows":len(src),"canonical_games":len(games),"matched":len(matched),
      "missing":len(missing),"ambiguous":len(ambiguous),"unique_game_pks":len(used),
      "result_counts":result_counts,
      "missing_examples":missing[:10],"ambiguous_examples":ambiguous[:10]
    }
    print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)
    if len(src)!=2792 or len(matched)!=2792 or missing or ambiguous or len(used)!=2792:
        raise SystemExit(2)
    write_sql(matched)
    (OUT/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")

if __name__=="__main__": main()
