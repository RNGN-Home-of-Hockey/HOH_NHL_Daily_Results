import pathlib
import sqlite3

ROOT=pathlib.Path(__file__).resolve().parents[1]
SQL=(ROOT/"tools"/"refresh_team_current_snapshots.sql").read_text(encoding="utf-8")

db=sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE teams(tri_code TEXT PRIMARY KEY);
CREATE TABLE games(game_pk INTEGER PRIMARY KEY,game_type INTEGER,scheduled_start_utc TEXT);
CREATE TABLE team_game_features(
  game_pk INTEGER,team_tri TEXT,game_type INTEGER,scheduled_start_utc TEXT,
  final_goals_for REAL,final_goals_against REAL,final_goal_diff REAL,total_goals REAL,
  corsi_for_pct REAL,fenwick_for_pct REAL,p2_goals_for REAL,p2_goals_against REAL
);
CREATE TABLE team_game_advanced_features(
  game_pk INTEGER,team_tri TEXT,toi_5v5_minutes REAL,xgf_pct_5v5 REAL,
  xgf_5v5 REAL,xga_5v5 REAL,corsi_for_pct_5v5 REAL,fenwick_for_pct_5v5 REAL,
  pdo_5v5 REAL,goals_saved_above_expected REAL
);
CREATE TABLE team_current_snapshots(
  team_tri TEXT NOT NULL,window_games INTEGER NOT NULL,as_of_utc TEXT NOT NULL,
  sample_size INTEGER NOT NULL,league_teams INTEGER,
  gf_pg REAL,ga_pg REAL,goal_diff_pg REAL,total_pg REAL,corsi_pct REAL,fenwick_pct REAL,p2_diff_pg REAL,
  rank_gf INTEGER,rank_ga INTEGER,rank_goal_diff INTEGER,rank_total INTEGER,
  rank_corsi INTEGER,rank_fenwick INTEGER,rank_p2_diff INTEGER,
  advanced_sample_size INTEGER,advanced_league_teams INTEGER,xgf_pct_5v5 REAL,
  xgf60_5v5 REAL,xga60_5v5 REAL,corsi_pct_5v5 REAL,fenwick_pct_5v5 REAL,pdo_5v5 REAL,gsax_5v5 REAL,
  rank_xgf_pct_5v5 INTEGER,rank_xgf60_5v5 INTEGER,rank_xga60_5v5 INTEGER,
  rank_corsi_pct_5v5 INTEGER,rank_fenwick_pct_5v5 INTEGER,computed_at TEXT,
  PRIMARY KEY(team_tri,window_games)
);
CREATE TABLE data_core_meta(meta_key TEXT PRIMARY KEY,meta_value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
""")

for ti in range(32):
    team=f"T{ti:02d}"
    db.execute("INSERT INTO teams VALUES(?)",(team,))
    for n in range(25):
        game_pk=ti*1000+n+1
        when=f"2026-04-{(n%28)+1:02d}T{n%24:02d}:00:00Z"
        gf=2.0+ti*0.03+(n%3)*0.1
        ga=3.2-ti*0.02+(n%2)*0.1
        db.execute("INSERT INTO games VALUES(?,?,?)",(game_pk,2,when))
        db.execute(
          "INSERT INTO team_game_features VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          (game_pk,team,2,when,gf,ga,gf-ga,gf+ga,48+ti*0.1,49+ti*0.1,n%3,(n+1)%2),
        )
        db.execute(
          "INSERT INTO team_game_advanced_features VALUES(?,?,?,?,?,?,?,?,?,?)",
          (game_pk,team,50,47+ti*0.15,2.0+ti*0.02,3.0-ti*0.01,48+ti*0.1,49+ti*0.1,100,ti*0.05),
        )

db.executescript(SQL)
rows=db.execute("SELECT COUNT(*) FROM team_current_snapshots").fetchone()[0]
teams=db.execute("SELECT COUNT(DISTINCT team_tri) FROM team_current_snapshots").fetchone()[0]
assert rows==96,(rows,teams)
assert teams==32
for window in (5,10,20):
    row=db.execute("""
      SELECT COUNT(*),MIN(league_teams),MAX(league_teams),
             MIN(advanced_league_teams),MAX(advanced_league_teams)
      FROM team_current_snapshots WHERE window_games=?
    """,(window,)).fetchone()
    assert row==(32,32,32,32,32),(window,row)
meta=dict(db.execute("SELECT meta_key,meta_value FROM data_core_meta"))
assert meta["compact.team_current_snapshots"]=="96"
assert meta["build.current_created_at"]
print("TEAM_CURRENT_SNAPSHOT_REFRESH_OK",rows,teams)
