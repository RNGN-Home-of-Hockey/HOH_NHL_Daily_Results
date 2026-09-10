#!/usr/bin/env python3
"""Build a compact local analytics warehouse from the downloaded NHL archive.

Inputs (all local, gitignored):
- local-data/nhl-history/games/<season>/<gamePk>/boxscore.json
- local-data/nhl-history/games/<season>/<gamePk>/play-by-play.json
- local-data/hockeystats/2025-26/teams/*.csv  (optional manual 5v5 source)

Outputs:
- local-data/warehouse/hoh_history.sqlite
- local-data/warehouse/summary.json
- local-data/warehouse/d1-chunks/*.sql

The generated D1 package intentionally excludes raw play-by-play and players. It contains
only compact team/game/period features required by the current betting insight engine.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import math
from pathlib import Path
import shutil
import sqlite3
from collections import Counter, defaultdict

ROOT = Path.cwd()
HISTORY_ROOT = ROOT / "local-data" / "nhl-history"
CSV_ROOT = ROOT / "local-data" / "hockeystats" / "2025-26" / "teams"
OUT_ROOT = ROOT / "local-data" / "warehouse"
DB_PATH = OUT_ROOT / "hoh_history.sqlite"
CHUNK_ROOT = OUT_ROOT / "d1-chunks"

FINAL_STATES = {"FINAL", "OFF"}
ELIGIBLE_GAME_TYPES = {2, 3}
SHOT_TYPES = {"goal", "shot-on-goal"}
FENWICK_TYPES = {"goal", "shot-on-goal", "missed-shot"}
CORSI_TYPES = {"goal", "shot-on-goal", "missed-shot", "blocked-shot"}
OPP_MAP = {"L.A": "LAK", "N.J": "NJD", "S.J": "SJS", "T.B": "TBL"}


def text(v):
    return v.strip() if isinstance(v, str) else None


def num(v):
    if v is None or v == "": return None
    try: return float(v)
    except (TypeError, ValueError): return None


def integer(v):
    n = num(v)
    return int(n) if n is not None and float(n).is_integer() else None


def localized(v):
    if isinstance(v, str): return v
    if isinstance(v, dict):
        return v.get("default") or v.get("en") or next((x for x in v.values() if isinstance(x, str)), None)
    return None


def sql_value(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "1" if v else "0"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)): return "NULL"
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def create_schema(db):
    db.executescript("""
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE teams(tri_code TEXT PRIMARY KEY, name_en TEXT NOT NULL);
    CREATE TABLE games(
      game_pk INTEGER PRIMARY KEY, season_id TEXT NOT NULL, game_type INTEGER NOT NULL,
      scheduled_start_utc TEXT NOT NULL, game_date TEXT NOT NULL, game_state TEXT NOT NULL,
      home_tri TEXT NOT NULL, away_tri TEXT NOT NULL, home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL, current_period INTEGER, period_type TEXT, venue_name TEXT
    );
    CREATE INDEX idx_wh_games_date ON games(game_date);
    CREATE TABLE period_scores(
      game_pk INTEGER NOT NULL, period_number INTEGER NOT NULL, period_type TEXT NOT NULL,
      home_goals INTEGER NOT NULL, away_goals INTEGER NOT NULL,
      PRIMARY KEY(game_pk,period_number,period_type)
    );
    CREATE TABLE team_game_stats(
      game_pk INTEGER NOT NULL, team_tri TEXT NOT NULL, is_home INTEGER NOT NULL,
      goals INTEGER NOT NULL, shots INTEGER, shot_attempts INTEGER, blocked_shots INTEGER,
      hits INTEGER, pim INTEGER, giveaways INTEGER, takeaways INTEGER, faceoff_pct REAL,
      power_play_goals INTEGER, power_play_opportunities INTEGER, shorthanded_goals INTEGER,
      PRIMARY KEY(game_pk,team_tri)
    );
    CREATE TABLE team_game_features(
      game_pk INTEGER NOT NULL, team_tri TEXT NOT NULL, opponent_tri TEXT NOT NULL,
      season_id TEXT NOT NULL, game_type INTEGER NOT NULL, scheduled_start_utc TEXT NOT NULL,
      is_home INTEGER NOT NULL, final_goals_for INTEGER NOT NULL, final_goals_against INTEGER NOT NULL,
      total_goals INTEGER NOT NULL, final_goal_diff INTEGER NOT NULL, final_win INTEGER NOT NULL,
      regulation_goals_for INTEGER NOT NULL, regulation_goals_against INTEGER NOT NULL,
      regulation_goal_diff INTEGER NOT NULL, regulation_result TEXT NOT NULL,
      went_ot INTEGER NOT NULL, went_so INTEGER NOT NULL,
      p1_goals_for INTEGER NOT NULL, p1_goals_against INTEGER NOT NULL,
      p2_goals_for INTEGER NOT NULL, p2_goals_against INTEGER NOT NULL,
      p3_goals_for INTEGER NOT NULL, p3_goals_against INTEGER NOT NULL,
      score_after_p1_diff INTEGER NOT NULL, score_after_p2_diff INTEGER NOT NULL,
      first_goal_for INTEGER, shots_for INTEGER, shots_against INTEGER, shot_share_pct REAL,
      corsi_for INTEGER, corsi_against INTEGER, corsi_for_pct REAL,
      fenwick_for INTEGER, fenwick_against INTEGER, fenwick_for_pct REAL,
      p1_shots_for INTEGER, p1_shots_against INTEGER, p2_shots_for INTEGER,
      p2_shots_against INTEGER, p3_shots_for INTEGER, p3_shots_against INTEGER,
      power_play_goals_for INTEGER, power_play_goals_against INTEGER,
      hits_for INTEGER, hits_against INTEGER, pim_for INTEGER, pim_against INTEGER,
      previous_game_utc TEXT, rest_days INTEGER, is_back_to_back INTEGER NOT NULL,
      feature_version INTEGER NOT NULL DEFAULT 2,
      PRIMARY KEY(game_pk,team_tri)
    );
    CREATE INDEX idx_wh_features_team_time ON team_game_features(team_tri,scheduled_start_utc);
    CREATE TABLE team_game_advanced_features(
      game_pk INTEGER NOT NULL, team_tri TEXT NOT NULL, season_id TEXT NOT NULL,
      source TEXT NOT NULL, toi_5v5_minutes REAL, gf_pct_5v5 REAL, xgf_pct_5v5 REAL,
      sf_pct_5v5 REAL, goals_for_5v5 INTEGER, goals_against_5v5 INTEGER,
      xgf_5v5 REAL, xga_5v5 REAL, shots_for_5v5 INTEGER, shots_against_5v5 INTEGER,
      shooting_pct_5v5 REAL, save_pct_5v5 REAL, pdo_5v5 REAL,
      goals_minus_expected REAL, goals_saved_above_expected REAL,
      corsi_for_5v5 INTEGER, corsi_against_5v5 INTEGER, corsi_for_pct_5v5 REAL,
      fenwick_for_5v5 INTEGER, fenwick_against_5v5 INTEGER, fenwick_for_pct_5v5 REAL,
      shot_diff_5v5 REAL, xg_diff_5v5 REAL, goal_diff_5v5 REAL,
      PRIMARY KEY(game_pk,team_tri)
    );
    """)


def iter_game_dirs():
    base = HISTORY_ROOT / "games"
    for season_dir in sorted(base.glob("20*")):
        for game_dir in sorted(season_dir.iterdir()):
            if not game_dir.is_dir(): continue
            box = game_dir / "boxscore.json"
            pbp = game_dir / "play-by-play.json"
            if box.exists() and pbp.exists():
                yield season_dir.name, game_dir, box, pbp


def team_name(team):
    return localized(team.get("commonName")) or localized(team.get("name")) or localized(team.get("placeName")) or team.get("abbrev")


def sum_player_field(box, side, field):
    vals = []
    for group in ("forwards", "defense", "goalies"):
        for p in ((box.get("playerByGameStats") or {}).get(side) or {}).get(group) or []:
            v = num(p.get(field))
            if v is not None: vals.append(v)
    if not vals: return None
    total = sum(vals)
    return int(total) if float(total).is_integer() else total


def parse_game(season_hint, box, pbp):
    game_pk = integer(box.get("id"))
    if not game_pk or game_pk != integer(pbp.get("id")): raise ValueError("game id mismatch")
    season = str(box.get("season") or season_hint)
    game_type = integer(box.get("gameType")) or integer(pbp.get("gameType")) or 0
    state = str(box.get("gameState") or "").upper()
    if game_type not in ELIGIBLE_GAME_TYPES or state not in FINAL_STATES: return None
    home = box.get("homeTeam") or {}; away = box.get("awayTeam") or {}
    home_tri = str(home.get("abbrev") or "").upper(); away_tri = str(away.get("abbrev") or "").upper()
    if not home_tri or not away_tri: raise ValueError("missing team abbrev")
    start = text(box.get("startTimeUTC")) or text(pbp.get("startTimeUTC"))
    game_date = text(box.get("gameDate")) or text(pbp.get("gameDate")) or (start[:10] if start else None)
    if not start or not game_date: raise ValueError("missing game date/time")
    home_score = integer(home.get("score")); away_score = integer(away.get("score"))
    if home_score is None or away_score is None: raise ValueError("missing score")
    home_id = integer(home.get("id")); away_id = integer(away.get("id"))
    id_to_tri = {home_id: home_tri, away_id: away_tri}

    period_goals = defaultdict(lambda: [0,0,"REG"])
    first_goal_tri = None
    corsi = Counter(); fenwick = Counter(); period_shots = Counter(); faceoff_wins = Counter(); faceoffs = 0
    went_ot = False; went_so = False
    for play in pbp.get("plays") or []:
        typ = text(play.get("typeDescKey")) or ""
        pd = play.get("periodDescriptor") or {}
        pn = integer(pd.get("number")); pt = text(pd.get("periodType")) or "REG"
        if pt == "OT" or (pn is not None and pn > 3 and pt != "SO"): went_ot = True
        if pt == "SO": went_so = True; went_ot = True
        details = play.get("details") or {}
        owner = id_to_tri.get(integer(details.get("eventOwnerTeamId")))
        if typ == "goal" and pt != "SO" and owner:
            if first_goal_tri is None: first_goal_tri = owner
            if pn is not None:
                pair = period_goals[(pn,pt)]
                pair[0 if owner == home_tri else 1] += 1
                pair[2] = pt
        if typ in CORSI_TYPES and owner:
            attack = owner
            if typ == "blocked-shot": attack = away_tri if owner == home_tri else home_tri
            corsi[attack] += 1
            if typ in FENWICK_TYPES: fenwick[attack] += 1
            if typ in SHOT_TYPES and pn in (1,2,3): period_shots[(attack,pn)] += 1
        if typ == "faceoff" and owner:
            faceoffs += 1; faceoff_wins[owner] += 1

    p = {n:[0,0] for n in (1,2,3)}
    for (pn,pt),(hg,ag,_) in period_goals.items():
        if pn in p and pt != "SO": p[pn] = [hg,ag]
    reg_home = sum(p[n][0] for n in p); reg_away = sum(p[n][1] for n in p)

    def team_stats(side, tri, team, is_home):
        return {
            "game_pk":game_pk,"team_tri":tri,"is_home":is_home,"goals":integer(team.get("score")) or 0,
            "shots":integer(team.get("sog")),"shot_attempts":corsi.get(tri),
            "blocked_shots":sum_player_field(box,side,"blockedShots"),"hits":sum_player_field(box,side,"hits"),
            "pim":sum_player_field(box,side,"pim"),"giveaways":sum_player_field(box,side,"giveaways"),
            "takeaways":sum_player_field(box,side,"takeaways"),
            "faceoff_pct":(faceoff_wins.get(tri,0)/faceoffs if faceoffs else None),
            "power_play_goals":sum_player_field(box,side,"powerPlayGoals"),
            "power_play_opportunities":None,"shorthanded_goals":sum_player_field(box,side,"shorthandedGoals"),
        }
    hs=team_stats("homeTeam",home_tri,home,1); aws=team_stats("awayTeam",away_tri,away,0)

    def feature(tri,opp,is_home,final_for,final_against,reg_for,reg_against,side_stats,opp_stats,period_for,period_against):
        cf=corsi.get(tri,0); ca=corsi.get(opp,0); ff=fenwick.get(tri,0); fa=fenwick.get(opp,0)
        sf=side_stats["shots"]; sa=opp_stats["shots"]
        share=lambda a,b: (100.0*a/(a+b)) if a is not None and b is not None and a+b>0 else None
        rr="W" if reg_for>reg_against else "L" if reg_for<reg_against else "T"
        return {
            "game_pk":game_pk,"team_tri":tri,"opponent_tri":opp,"season_id":season,"game_type":game_type,
            "scheduled_start_utc":start,"is_home":is_home,"final_goals_for":final_for,"final_goals_against":final_against,
            "total_goals":final_for+final_against,"final_goal_diff":final_for-final_against,"final_win":int(final_for>final_against),
            "regulation_goals_for":reg_for,"regulation_goals_against":reg_against,"regulation_goal_diff":reg_for-reg_against,
            "regulation_result":rr,"went_ot":int(went_ot),"went_so":int(went_so),
            "p1_goals_for":period_for[0],"p1_goals_against":period_against[0],
            "p2_goals_for":period_for[1],"p2_goals_against":period_against[1],
            "p3_goals_for":period_for[2],"p3_goals_against":period_against[2],
            "score_after_p1_diff":period_for[0]-period_against[0],
            "score_after_p2_diff":sum(period_for[:2])-sum(period_against[:2]),
            "first_goal_for":None if first_goal_tri is None else int(first_goal_tri==tri),
            "shots_for":sf,"shots_against":sa,"shot_share_pct":share(sf,sa),
            "corsi_for":cf,"corsi_against":ca,"corsi_for_pct":share(cf,ca),
            "fenwick_for":ff,"fenwick_against":fa,"fenwick_for_pct":share(ff,fa),
            "p1_shots_for":period_shots.get((tri,1),0),"p1_shots_against":period_shots.get((opp,1),0),
            "p2_shots_for":period_shots.get((tri,2),0),"p2_shots_against":period_shots.get((opp,2),0),
            "p3_shots_for":period_shots.get((tri,3),0),"p3_shots_against":period_shots.get((opp,3),0),
            "power_play_goals_for":side_stats["power_play_goals"],"power_play_goals_against":opp_stats["power_play_goals"],
            "hits_for":side_stats["hits"],"hits_against":opp_stats["hits"],"pim_for":side_stats["pim"],"pim_against":opp_stats["pim"],
            "previous_game_utc":None,"rest_days":None,"is_back_to_back":0,"feature_version":2,
        }

    home_pf=[p[n][0] for n in (1,2,3)]; away_pf=[p[n][1] for n in (1,2,3)]
    current_pd = box.get("periodDescriptor") or pbp.get("periodDescriptor") or {}
    game={"game_pk":game_pk,"season_id":season,"game_type":game_type,"scheduled_start_utc":start,"game_date":game_date,
          "game_state":state,"home_tri":home_tri,"away_tri":away_tri,"home_score":home_score,"away_score":away_score,
          "current_period":integer(current_pd.get("number")),"period_type":text(current_pd.get("periodType")),
          "venue_name":localized(box.get("venue")) or localized((box.get("venue") or {}).get("default") if isinstance(box.get("venue"),dict) else None)}
    periods=[]
    for (pn,pt),(hg,ag,_) in sorted(period_goals.items()):
        periods.append({"game_pk":game_pk,"period_number":pn,"period_type":pt,"home_goals":hg,"away_goals":ag})
    return {
      "teams":[(home_tri,team_name(home)),(away_tri,team_name(away))],"game":game,"periods":periods,
      "team_stats":[hs,aws],
      "features":[
        feature(home_tri,away_tri,1,home_score,away_score,reg_home,reg_away,hs,aws,home_pf,away_pf),
        feature(away_tri,home_tri,0,away_score,home_score,reg_away,reg_home,aws,hs,away_pf,home_pf),
      ]
    }


def insert_dict(db, table, row):
    cols=list(row); q=','.join('?' for _ in cols)
    db.execute(f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({q})", [row[c] for c in cols])


def load_official(db):
    parsed=[]; errors=[]
    dirs=list(iter_game_dirs())
    print(f"OFFICIAL: parsing {len(dirs)} downloaded games", flush=True)
    for i,(season,game_dir,box_path,pbp_path) in enumerate(dirs,1):
        try:
            box=json.loads(box_path.read_text(encoding='utf-8')); pbp=json.loads(pbp_path.read_text(encoding='utf-8'))
            g=parse_game(season,box,pbp)
            if g: parsed.append(g)
        except Exception as e:
            errors.append({"game":game_dir.name,"error":str(e)})
        if i%250==0 or i==len(dirs): print(f"OFFICIAL: {i}/{len(dirs)} parsed, errors={len(errors)}", flush=True)
    parsed.sort(key=lambda x:(x['game']['scheduled_start_utc'],x['game']['game_pk']))
    previous={}
    for item in parsed:
        for tri,name in item['teams']:
            db.execute("INSERT OR IGNORE INTO teams(tri_code,name_en) VALUES(?,?)",(tri,name or tri))
        insert_dict(db,'games',item['game'])
        for r in item['periods']: insert_dict(db,'period_scores',r)
        for r in item['team_stats']: insert_dict(db,'team_game_stats',r)
        for r in item['features']:
            last=previous.get(r['team_tri'])
            if last:
                r['previous_game_utc']=last
                a=dt.datetime.fromisoformat(last.replace('Z','+00:00')).date(); b=dt.datetime.fromisoformat(r['scheduled_start_utc'].replace('Z','+00:00')).date()
                delta=(b-a).days
                r['rest_days']=max(0,delta-1); r['is_back_to_back']=int(delta==1)
            previous[r['team_tri']]=r['scheduled_start_utc']
            insert_dict(db,'team_game_features',r)
    db.commit()
    return parsed,errors


def norm_opp(v):
    v=(v or '').strip().upper(); return OPP_MAP.get(v,v)


def csv_float(row,key): return num(row.get(key))
def csv_int(row,key): return integer(row.get(key))


def load_manual_advanced(db):
    if not CSV_ROOT.exists(): return {"files":0,"matched_files":0,"rows":0,"unmatched":[]}
    games_by_date=defaultdict(list)
    for r in db.execute("SELECT game_pk,season_id,game_date,home_tri,away_tri FROM games"):
        games_by_date[r[2]].append({"game_pk":r[0],"season":r[1],"home":r[3],"away":r[4]})
    files=sorted(CSV_ROOT.glob('*.csv')); inserted=0; matched_files=0; unmatched=[]
    for path in files:
        with path.open('r',encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
        guesses=[]
        for row in rows:
            date=(row.get('Date') or '').strip(); opp=norm_opp(row.get('Opponent'))
            candidates=[]
            for g in games_by_date.get(date,[]):
                if g['home']==opp: candidates.append((g,g['away']))
                elif g['away']==opp: candidates.append((g,g['home']))
            if len(candidates)==1: guesses.append(candidates[0][1])
        if not guesses:
            unmatched.append({"file":path.name,"reason":"could_not_identify_team"}); continue
        team,count=Counter(guesses).most_common(1)[0]
        if count < max(10,int(len(rows)*0.70)):
            unmatched.append({"file":path.name,"reason":"ambiguous_team","best":team,"matches":count}); continue
        matched_files += 1
        for row in rows:
            date=(row.get('Date') or '').strip(); opp=norm_opp(row.get('Opponent'))
            matches=[g for g in games_by_date.get(date,[]) if {g['home'],g['away']}=={team,opp}]
            if len(matches)!=1: continue
            g=matches[0]
            adv={
              "game_pk":g['game_pk'],"team_tri":team,"season_id":g['season'],"source":"manual_hockeystats_csv",
              "toi_5v5_minutes":csv_float(row,'TOI'),"gf_pct_5v5":csv_float(row,'GF%'),"xgf_pct_5v5":csv_float(row,'xGF%'),
              "sf_pct_5v5":csv_float(row,'SF%'),"goals_for_5v5":csv_int(row,'GF'),"goals_against_5v5":csv_int(row,'GA'),
              "xgf_5v5":csv_float(row,'xGF'),"xga_5v5":csv_float(row,'xGA'),"shots_for_5v5":csv_int(row,'SF'),
              "shots_against_5v5":csv_int(row,'SA'),"shooting_pct_5v5":csv_float(row,'Sh%'),"save_pct_5v5":csv_float(row,'Sv%'),
              "pdo_5v5":csv_float(row,'PDO'),"goals_minus_expected":csv_float(row,'G±Ax'),"goals_saved_above_expected":csv_float(row,'GSAx'),
              "corsi_for_5v5":csv_int(row,'CF'),"corsi_against_5v5":csv_int(row,'CA'),"corsi_for_pct_5v5":csv_float(row,'CF%'),
              "fenwick_for_5v5":csv_int(row,'FF'),"fenwick_against_5v5":csv_int(row,'FA'),"fenwick_for_pct_5v5":csv_float(row,'FF%'),
              "shot_diff_5v5":csv_float(row,'S±'),"xg_diff_5v5":csv_float(row,'xG±'),"goal_diff_5v5":csv_float(row,'G±'),
            }
            insert_dict(db,'team_game_advanced_features',adv); inserted+=1
    db.commit()
    return {"files":len(files),"matched_files":matched_files,"rows":inserted,"unmatched":unmatched}


def write_multirow_sql(path,table,cols,rows,conflict_cols,update_cols=None):
    if not rows: return
    values=',\n'.join('('+','.join(sql_value(r[c]) for c in cols)+')' for r in rows)
    if update_cols is None: update_cols=[c for c in cols if c not in conflict_cols]
    conflict=','.join(conflict_cols)
    update=','.join(f"{c}=excluded.{c}" for c in update_cols)
    path.write_text(f"INSERT INTO {table} ({','.join(cols)}) VALUES\n{values}\nON CONFLICT({conflict}) DO UPDATE SET {update};\n",encoding='utf-8')


def export_table(db,table,conflict_cols,prefix,batch=200,exclude=()):
    rows=[dict(r) for r in db.execute(f"SELECT * FROM {table}")]
    if not rows: return 0
    cols=[c for c in rows[0].keys() if c not in exclude]
    for idx in range(0,len(rows),batch):
        write_multirow_sql(CHUNK_ROOT/f"{prefix}_{idx//batch:04d}.sql",table,cols,rows[idx:idx+batch],conflict_cols)
    return len(rows)


def export_d1(db):
    if CHUNK_ROOT.exists(): shutil.rmtree(CHUNK_ROOT)
    CHUNK_ROOT.mkdir(parents=True,exist_ok=True)
    counts={}
    counts['teams']=export_table(db,'teams',['tri_code'],'010_teams',100)
    counts['games']=export_table(db,'games',['game_pk'],'020_games',150,exclude=('game_date',))
    counts['period_scores']=export_table(db,'period_scores',['game_pk','period_number','period_type'],'030_periods',250)
    counts['team_game_stats']=export_table(db,'team_game_stats',['game_pk','team_tri'],'040_team_stats',200)
    counts['team_game_features']=export_table(db,'team_game_features',['game_pk','team_tri'],'050_features',150)
    counts['team_game_advanced_features']=export_table(db,'team_game_advanced_features',['game_pk','team_tri'],'060_advanced',150)
    return counts


def main():
    if not (HISTORY_ROOT/'complete.json').exists(): raise SystemExit('Missing local-data/nhl-history/complete.json. Run bulk_history_download.py first.')
    OUT_ROOT.mkdir(parents=True,exist_ok=True)
    if DB_PATH.exists(): DB_PATH.unlink()
    db=sqlite3.connect(DB_PATH); db.row_factory=sqlite3.Row; create_schema(db)
    parsed,errors=load_official(db)
    advanced=load_manual_advanced(db)
    counts=export_d1(db)
    summary={"ok":not errors,"official_games":len(parsed),"official_errors":errors,"manual_advanced":advanced,"d1_rows":counts,
             "sqlite":str(DB_PATH),"chunks":len(list(CHUNK_ROOT.glob('*.sql'))),"created_at":dt.datetime.now(dt.timezone.utc).isoformat()}
    (OUT_ROOT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)
    if errors: raise SystemExit(2)

if __name__=='__main__': main()
