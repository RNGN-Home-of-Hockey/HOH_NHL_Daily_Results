PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS postgame_ingestion_status (
  game_pk INTEGER PRIMARY KEY,
  ordinary_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ordinary_status IN ('pending','complete','error')),
  features_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (features_status IN ('pending','complete','error')),
  odds_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (odds_status IN ('pending','complete','no_data','error')),
  advanced_status TEXT NOT NULL DEFAULT 'pending_external'
    CHECK (advanced_status IN ('pending_external','partial','complete')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  ordinary_completed_at TEXT,
  features_completed_at TEXT,
  odds_completed_at TEXT,
  advanced_completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_postgame_ingestion_pending
  ON postgame_ingestion_status(ordinary_status,features_status,odds_status,next_retry_at);

CREATE INDEX IF NOT EXISTS idx_postgame_ingestion_advanced
  ON postgame_ingestion_status(advanced_status,updated_at);

CREATE TABLE IF NOT EXISTS winline_market_lifecycle (
  game_pk INTEGER NOT NULL,
  winline_market_id TEXT NOT NULL,
  winline_event_id TEXT,
  market_type TEXT NOT NULL,
  subject_type TEXT,
  subject_key TEXT,
  outcome_name TEXT,
  opening_odds REAL NOT NULL,
  opening_at TEXT NOT NULL,
  closing_odds REAL NOT NULL,
  closing_at TEXT NOT NULL,
  min_odds REAL NOT NULL,
  max_odds REAL NOT NULL,
  snapshot_count INTEGER NOT NULL,
  odds_change REAL NOT NULL DEFAULT 0,
  finalized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk,winline_market_id),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_winline_lifecycle_game
  ON winline_market_lifecycle(game_pk,market_type);

CREATE INDEX IF NOT EXISTS idx_winline_lifecycle_market
  ON winline_market_lifecycle(market_type,subject_key,outcome_name,game_pk);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('postgame_ingestion.version','1',CURRENT_TIMESTAMP),
  ('winline_market_lifecycle.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
