PRAGMA foreign_keys = ON;

-- Per-game cursor for Telegram live notifications. This prevents a newly
-- enabled notifier from replaying every historical goal in a game and lets the
-- 5-minute Worker cron process only newly observed NHL play-by-play events.
CREATE TABLE IF NOT EXISTS live_notification_cursors (
  game_pk INTEGER PRIMARY KEY,
  last_sort_order INTEGER NOT NULL DEFAULT 0,
  last_game_state TEXT,
  last_period INTEGER,
  initialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_live_notification_cursors_updated
  ON live_notification_cursors(updated_at);
