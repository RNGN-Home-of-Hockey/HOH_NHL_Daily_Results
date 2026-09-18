PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_h2h_snapshots (
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  games INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  goals_for INTEGER NOT NULL,
  goals_against INTEGER NOT NULL,
  goals_for_pg REAL,
  goals_against_pg REAL,
  total_goals_pg REAL,
  shots_for INTEGER,
  shots_against INTEGER,
  shot_share_pct REAL,
  corsi_for INTEGER,
  corsi_against INTEGER,
  corsi_for_pct REAL,
  fenwick_for INTEGER,
  fenwick_against INTEGER,
  fenwick_for_pct REAL,
  power_play_goals_for INTEGER,
  power_play_goals_against INTEGER,
  hits_for INTEGER,
  hits_against INTEGER,
  pim_for INTEGER,
  pim_against INTEGER,
  first_goal_pct REAL,
  p1_goal_diff_pg REAL,
  p2_goal_diff_pg REAL,
  p3_goal_diff_pg REAL,
  ot_games INTEGER NOT NULL DEFAULT 0,
  so_games INTEGER NOT NULL DEFAULT 0,
  last_game_utc TEXT,
  evidence_game_pks_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_tri, opponent_tri, scope_key),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code),
  FOREIGN KEY (opponent_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_team_h2h_lookup
  ON team_h2h_snapshots(team_tri, opponent_tri, scope_key);

CREATE INDEX IF NOT EXISTS idx_team_h2h_opponent
  ON team_h2h_snapshots(opponent_tri, team_tri, scope_key);

CREATE TABLE IF NOT EXISTS nhl_official_stat_reports (
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('team','skater','goalie')),
  report_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  team_tri TEXT,
  player_id INTEGER,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season_id, game_type, entity_type, report_name, row_key)
);

CREATE INDEX IF NOT EXISTS idx_nhl_official_reports_team
  ON nhl_official_stat_reports(season_id, game_type, entity_type, team_tri, report_name);

CREATE INDEX IF NOT EXISTS idx_nhl_official_reports_player
  ON nhl_official_stat_reports(player_id, season_id, game_type, entity_type, report_name);

INSERT INTO data_core_meta(meta_key, meta_value, updated_at)
VALUES
  ('h2h.seasons', '20242025,20252026', CURRENT_TIMESTAMP),
  ('h2h.version', '1', CURRENT_TIMESTAMP),
  ('nhl_official_reports.version', '1', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
