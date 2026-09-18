PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nhl_milestone_watch (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('skater','goalie')),
  player_id INTEGER NOT NULL,
  game_type INTEGER NOT NULL,
  team_tri TEXT,
  player_name TEXT,
  milestone_type TEXT NOT NULL,
  milestone_amount INTEGER NOT NULL,
  current_value REAL,
  remaining_value REAL,
  games_played INTEGER,
  goals INTEGER,
  assists INTEGER,
  points INTEGER,
  wins INTEGER,
  shutouts INTEGER,
  toi_minutes INTEGER,
  source_row_id INTEGER,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, player_id, game_type, milestone_type, milestone_amount)
);

CREATE INDEX IF NOT EXISTS idx_nhl_milestone_team
  ON nhl_milestone_watch(team_tri, game_type, remaining_value);

CREATE INDEX IF NOT EXISTS idx_nhl_milestone_player
  ON nhl_milestone_watch(player_id, game_type, remaining_value);

CREATE INDEX IF NOT EXISTS idx_nhl_milestone_nearest
  ON nhl_milestone_watch(game_type, remaining_value, milestone_type);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('nhl_milestones.version','1',CURRENT_TIMESTAMP),
  ('nhl_milestones.source','api.nhle.com/stats/rest/en/milestones',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
