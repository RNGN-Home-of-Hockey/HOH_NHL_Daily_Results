PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nhl_player_shift_game (
  game_pk INTEGER NOT NULL,
  season_id TEXT NOT NULL,
  team_tri TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  shift_count INTEGER NOT NULL,
  toi_seconds INTEGER NOT NULL,
  first_period INTEGER,
  first_shift_second INTEGER,
  last_period INTEGER,
  last_shift_second INTEGER,
  source TEXT NOT NULL DEFAULT 'nhl_shiftcharts',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, player_id)
);

CREATE INDEX IF NOT EXISTS idx_nhl_player_shift_team_season
  ON nhl_player_shift_game(team_tri, season_id, player_id);

CREATE INDEX IF NOT EXISTS idx_nhl_player_shift_player
  ON nhl_player_shift_game(player_id, season_id, game_pk);

CREATE TABLE IF NOT EXISTS nhl_player_pair_toi (
  scope_key TEXT NOT NULL,
  team_tri TEXT NOT NULL,
  player1_id INTEGER NOT NULL,
  player2_id INTEGER NOT NULL,
  games_together INTEGER NOT NULL,
  shared_toi_seconds INTEGER NOT NULL,
  shared_toi_seconds_pg REAL,
  last_game_pk INTEGER,
  last_game_utc TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_key, team_tri, player1_id, player2_id)
);

CREATE INDEX IF NOT EXISTS idx_nhl_player_pair_team_scope
  ON nhl_player_pair_toi(team_tri, scope_key, shared_toi_seconds DESC);

CREATE INDEX IF NOT EXISTS idx_nhl_player_pair_player1
  ON nhl_player_pair_toi(player1_id, scope_key, team_tri);

CREATE INDEX IF NOT EXISTS idx_nhl_player_pair_player2
  ON nhl_player_pair_toi(player2_id, scope_key, team_tri);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('nhl_shiftcharts.version','1',CURRENT_TIMESTAMP),
  ('nhl_shiftcharts.seasons','20242025,20252026',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
