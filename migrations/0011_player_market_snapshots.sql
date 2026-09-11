PRAGMA foreign_keys = ON;

-- Compact hit-rate layer for individual player markets. Detailed per-game logs
-- remain local; D1 stores only small rolling/opponent aggregates needed by the
-- Broadcast, Matchup Lab and Telegram products.
CREATE TABLE IF NOT EXISTS player_market_snapshots (
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('rolling','opponent')),
  scope_key TEXT NOT NULL,
  opponent_tri TEXT NOT NULL DEFAULT '',
  as_of_utc TEXT NOT NULL,
  games INTEGER NOT NULL,
  games_with_assist INTEGER NOT NULL DEFAULT 0,
  games_with_2plus_shots INTEGER NOT NULL DEFAULT 0,
  games_with_3plus_shots INTEGER NOT NULL DEFAULT 0,
  games_with_4plus_shots INTEGER NOT NULL DEFAULT 0,
  games_with_5plus_shots INTEGER NOT NULL DEFAULT 0,
  games_with_2plus_hits INTEGER NOT NULL DEFAULT 0,
  games_with_3plus_hits INTEGER NOT NULL DEFAULT 0,
  games_with_2plus_blocks INTEGER NOT NULL DEFAULT 0,
  assists_pg REAL,
  shots_pg REAL,
  hits_pg REAL,
  blocked_shots_pg REAL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, snapshot_type, scope_key, opponent_tri),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_player_market_team_scope
  ON player_market_snapshots(team_tri, snapshot_type, scope_key, player_id);

CREATE INDEX IF NOT EXISTS idx_player_market_opponent
  ON player_market_snapshots(opponent_tri, snapshot_type, scope_key, player_id);
