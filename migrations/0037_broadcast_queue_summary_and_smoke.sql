CREATE TABLE IF NOT EXISTS broadcast_queue_summaries (
  game_pk INTEGER PRIMARY KEY,
  strong_count INTEGER NOT NULL DEFAULT 0,
  priced_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  top_air_score INTEGER,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_broadcast_queue_summaries_generated
  ON broadcast_queue_summaries(generated_at);

CREATE TABLE IF NOT EXISTS broadcast_d1_smoke (
  smoke_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
