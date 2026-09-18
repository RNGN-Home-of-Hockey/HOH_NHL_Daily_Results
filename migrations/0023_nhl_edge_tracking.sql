PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nhl_edge_payloads (
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('league','team','skater','goalie')),
  entity_id INTEGER NOT NULL,
  entity_key TEXT,
  report_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season_id, game_type, entity_type, entity_id, report_name)
);

CREATE INDEX IF NOT EXISTS idx_nhl_edge_entity
  ON nhl_edge_payloads(entity_type, entity_id, season_id, game_type, report_name);

CREATE INDEX IF NOT EXISTS idx_nhl_edge_team_key
  ON nhl_edge_payloads(entity_key, season_id, game_type, entity_type);

CREATE TABLE IF NOT EXISTS nhl_edge_features (
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('team','skater','goalie')),
  entity_id INTEGER NOT NULL,
  entity_key TEXT,
  top_shot_speed_mph REAL,
  skating_speed_max_mph REAL,
  bursts_over_20 INTEGER,
  bursts_over_22 INTEGER,
  distance_miles REAL,
  offensive_zone_pct REAL,
  neutral_zone_pct REAL,
  defensive_zone_pct REAL,
  high_danger_shots INTEGER,
  high_danger_goals INTEGER,
  high_danger_saves INTEGER,
  high_danger_goals_against INTEGER,
  high_danger_save_pct REAL,
  feature_json TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season_id, game_type, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_nhl_edge_features_team
  ON nhl_edge_features(entity_key, season_id, game_type, entity_type);

CREATE INDEX IF NOT EXISTS idx_nhl_edge_features_speed
  ON nhl_edge_features(season_id, game_type, entity_type, skating_speed_max_mph DESC);

CREATE INDEX IF NOT EXISTS idx_nhl_edge_features_zone
  ON nhl_edge_features(season_id, game_type, entity_type, offensive_zone_pct DESC);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('nhl_edge.version','1',CURRENT_TIMESTAMP),
  ('nhl_edge.seasons','20242025,20252026',CURRENT_TIMESTAMP),
  ('nhl_edge.source','api-web.nhle.com/v1/edge',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
