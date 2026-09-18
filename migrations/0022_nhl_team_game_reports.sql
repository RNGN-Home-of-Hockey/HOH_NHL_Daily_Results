PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nhl_team_game_report_rows (
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  report_name TEXT NOT NULL,
  game_pk INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  row_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_name, game_pk, team_tri, row_key)
);

CREATE INDEX IF NOT EXISTS idx_nhl_team_game_reports_game
  ON nhl_team_game_report_rows(game_pk, team_tri, report_name);

CREATE INDEX IF NOT EXISTS idx_nhl_team_game_reports_team_season
  ON nhl_team_game_report_rows(team_tri, season_id, game_type, report_name);

CREATE INDEX IF NOT EXISTS idx_nhl_team_game_reports_report
  ON nhl_team_game_report_rows(season_id, game_type, report_name, game_pk);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('nhl_team_game_reports.version','1',CURRENT_TIMESTAMP),
  ('nhl_team_game_reports.seasons','20242025,20252026',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
