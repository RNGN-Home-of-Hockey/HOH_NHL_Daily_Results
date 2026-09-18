PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS winline_market_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_pk INTEGER NOT NULL,
  winline_event_id TEXT NOT NULL,
  winline_market_id TEXT NOT NULL,
  market_type TEXT NOT NULL,
  subject_type TEXT,
  subject_key TEXT,
  outcome_name TEXT,
  odds REAL NOT NULL,
  deeplink TEXT,
  is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1)),
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_updated_at TEXT,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (winline_event_id) REFERENCES winline_events(winline_event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_winline_snapshots_game_captured
  ON winline_market_snapshots(game_pk, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_winline_snapshots_event_market
  ON winline_market_snapshots(winline_event_id, market_type, captured_at DESC);

-- Seed only rows that are demonstrably pregame. This deliberately excludes
-- current/live values that were updated after the scheduled puck drop.
INSERT INTO winline_market_snapshots (
  game_pk,winline_event_id,winline_market_id,market_type,subject_type,subject_key,
  outcome_name,odds,deeplink,is_live,captured_at,source_updated_at
)
SELECT e.game_pk,m.winline_event_id,m.winline_market_id,m.market_type,m.subject_type,m.subject_key,
       m.outcome_name,m.odds,m.deeplink,m.is_live,m.updated_at,m.updated_at
FROM winline_markets m
JOIN winline_events e ON e.winline_event_id=m.winline_event_id
JOIN games g ON g.game_pk=e.game_pk
WHERE e.game_pk IS NOT NULL
  AND m.is_live=0
  AND m.odds IS NOT NULL
  AND m.updated_at<=g.scheduled_start_utc
  AND NOT EXISTS (
    SELECT 1 FROM winline_market_snapshots s
    WHERE s.game_pk=e.game_pk AND s.winline_market_id=m.winline_market_id AND s.captured_at=m.updated_at
  );
