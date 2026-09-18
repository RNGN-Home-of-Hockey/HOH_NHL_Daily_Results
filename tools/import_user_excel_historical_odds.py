#!/usr/bin/env python3
from __future__ import annotations
import base64,csv,datetime as dt,gzip,io,json,math,re
from pathlib import Path

DATA_B64 = """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"""
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
    raw=gzip.decompress(base64.b64decode(DATA_B64)).decode("utf-8")
    return list(csv.DictReader(io.StringIO(raw)))

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
