PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notification_user_preferences (
  telegram_user_id INTEGER PRIMARY KEY,
  timezone_name TEXT,
  daily_player_digest INTEGER NOT NULL DEFAULT 1 CHECK (daily_player_digest IN (0,1)),
  daily_digest_hour INTEGER NOT NULL DEFAULT 20 CHECK (daily_digest_hour BETWEEN 0 AND 23),
  player_postgame_reports INTEGER NOT NULL DEFAULT 1 CHECK (player_postgame_reports IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_user_preferences_digest
  ON notification_user_preferences(daily_player_digest,daily_digest_hour);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES ('telegram_center.notification_preferences_v1','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
