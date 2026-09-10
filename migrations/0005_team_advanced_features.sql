PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_game_advanced_features (
  game_pk INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  season_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual_hockeystats_csv',
  toi_5v5_minutes REAL,
  gf_pct_5v5 REAL,
  xgf_pct_5v5 REAL,
  sf_pct_5v5 REAL,
  goals_for_5v5 INTEGER,
  goals_against_5v5 INTEGER,
  xgf_5v5 REAL,
  xga_5v5 REAL,
  shots_for_5v5 INTEGER,
  shots_against_5v5 INTEGER,
  shooting_pct_5v5 REAL,
  save_pct_5v5 REAL,
  pdo_5v5 REAL,
  goals_minus_expected REAL,
  goals_saved_above_expected REAL,
  corsi_for_5v5 INTEGER,
  corsi_against_5v5 INTEGER,
  corsi_for_pct_5v5 REAL,
  fenwick_for_5v5 INTEGER,
  fenwick_against_5v5 INTEGER,
  fenwick_for_pct_5v5 REAL,
  shot_diff_5v5 REAL,
  xg_diff_5v5 REAL,
  goal_diff_5v5 REAL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, team_tri),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_team_game_advanced_team_time
  ON team_game_advanced_features(team_tri, game_pk DESC);

CREATE INDEX IF NOT EXISTS idx_team_game_advanced_season_team
  ON team_game_advanced_features(season_id, team_tri, game_pk DESC);
