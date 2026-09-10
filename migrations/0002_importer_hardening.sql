ALTER TABLE players ADD COLUMN last_seen_game_start_utc TEXT;
ALTER TABLE players ADD COLUMN last_seen_game_pk INTEGER;

CREATE TABLE IF NOT EXISTS goalie_game_stats (
  game_pk INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  is_starter INTEGER CHECK (is_starter IN (0, 1)),
  decision TEXT,
  saves INTEGER,
  shots_against INTEGER,
  goals_against INTEGER,
  save_pct REAL,
  toi_seconds INTEGER,
  even_strength_goals_against INTEGER,
  power_play_goals_against INTEGER,
  shorthanded_goals_against INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, player_id),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_goalie_game_stats_player
  ON goalie_game_stats(player_id, game_pk);
