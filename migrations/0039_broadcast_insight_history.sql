PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS broadcast_insight_history (
  snapshot_key TEXT PRIMARY KEY,
  game_pk INTEGER NOT NULL,
  insight_id TEXT,
  category TEXT,
  feature_layer TEXT,
  headline_ru TEXT NOT NULL,
  market_type TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'GAME',
  subject TEXT,
  side TEXT,
  line REAL,
  first_odds REAL NOT NULL,
  latest_odds REAL NOT NULL,
  first_air_score INTEGER,
  max_air_score INTEGER,
  first_queue_rank INTEGER,
  best_queue_rank INTEGER,
  top_for_air_seen INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_count INTEGER NOT NULL DEFAULT 1,
  outcome_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(outcome_status IN ('pending','win','loss','push','void')),
  profit_units REAL,
  settled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_broadcast_insight_history_game
  ON broadcast_insight_history(game_pk,outcome_status);

CREATE INDEX IF NOT EXISTS idx_broadcast_insight_history_category
  ON broadcast_insight_history(category,outcome_status,max_air_score);

CREATE INDEX IF NOT EXISTS idx_broadcast_insight_history_layer
  ON broadcast_insight_history(feature_layer,outcome_status);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES('broadcast_insight_history.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
