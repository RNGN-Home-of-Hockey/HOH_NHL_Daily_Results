CREATE TABLE IF NOT EXISTS backfill_jobs (
  job_id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'complete', 'failed')),
  imported_games INTEGER NOT NULL DEFAULT 0,
  skipped_existing INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  day_key TEXT,
  day_imported_games INTEGER NOT NULL DEFAULT 0,
  last_game_pk INTEGER,
  last_error TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backfill_jobs_status
  ON backfill_jobs(status, updated_at);
