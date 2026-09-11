PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_current_snapshots (
  team_tri TEXT NOT NULL,
  window_games INTEGER NOT NULL CHECK (window_games IN (5,10,20)),
  as_of_utc TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  league_teams INTEGER,
  gf_pg REAL,
  ga_pg REAL,
  goal_diff_pg REAL,
  total_pg REAL,
  corsi_pct REAL,
  fenwick_pct REAL,
  p2_diff_pg REAL,
  rank_gf INTEGER,
  rank_ga INTEGER,
  rank_goal_diff INTEGER,
  rank_total INTEGER,
  rank_corsi INTEGER,
  rank_fenwick INTEGER,
  rank_p2_diff INTEGER,
  advanced_sample_size INTEGER,
  advanced_league_teams INTEGER,
  xgf_pct_5v5 REAL,
  xgf60_5v5 REAL,
  xga60_5v5 REAL,
  corsi_pct_5v5 REAL,
  fenwick_pct_5v5 REAL,
  pdo_5v5 REAL,
  gsax_5v5 REAL,
  rank_xgf_pct_5v5 INTEGER,
  rank_xgf60_5v5 INTEGER,
  rank_xga60_5v5 INTEGER,
  rank_corsi_pct_5v5 INTEGER,
  rank_fenwick_pct_5v5 INTEGER,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_tri, window_games),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_team_current_window_rank
  ON team_current_snapshots(window_games, rank_goal_diff, team_tri);

CREATE INDEX IF NOT EXISTS idx_team_current_window_xgf_rank
  ON team_current_snapshots(window_games, rank_xgf_pct_5v5, team_tri);
