PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_schedule_load (
  game_pk INTEGER NOT NULL,
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  scheduled_start_utc TEXT NOT NULL,
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  is_home INTEGER NOT NULL CHECK (is_home IN (0,1)),
  rest_days INTEGER,
  opponent_rest_days INTEGER,
  rest_advantage_days INTEGER,
  is_back_to_back INTEGER NOT NULL DEFAULT 0,
  is_3_in_4 INTEGER NOT NULL DEFAULT 0,
  is_4_in_6 INTEGER NOT NULL DEFAULT 0,
  games_prev_3d INTEGER NOT NULL DEFAULT 0,
  games_prev_5d INTEGER NOT NULL DEFAULT 0,
  games_prev_7d INTEGER NOT NULL DEFAULT 0,
  current_home_stand_game INTEGER NOT NULL DEFAULT 0,
  current_road_trip_game INTEGER NOT NULL DEFAULT 0,
  previous_game_pk INTEGER,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, team_tri)
);

CREATE INDEX IF NOT EXISTS idx_team_schedule_load_team
  ON team_schedule_load(team_tri, scheduled_start_utc);

CREATE INDEX IF NOT EXISTS idx_team_schedule_load_fatigue
  ON team_schedule_load(team_tri, is_back_to_back, is_3_in_4, is_4_in_6, scheduled_start_utc);

CREATE INDEX IF NOT EXISTS idx_team_schedule_load_game
  ON team_schedule_load(game_pk, team_tri);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('schedule_load.version','1',CURRENT_TIMESTAMP),
  ('schedule_load.definition','pregame schedule density derived from canonical NHL schedule only',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
