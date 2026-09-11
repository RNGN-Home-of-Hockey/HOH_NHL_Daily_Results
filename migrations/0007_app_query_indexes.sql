PRAGMA foreign_keys = ON;

-- Read paths used by the Control Center and Telegram Mini App.
-- These indexes are intentionally narrow: frequent user-facing lookups should
-- not turn into full-table scans on D1 Free.
CREATE INDEX IF NOT EXISTS idx_players_current_team_active_name
  ON players(current_team_tri, active, full_name_en);

CREATE INDEX IF NOT EXISTS idx_games_home_start_desc
  ON games(home_tri, scheduled_start_utc DESC);

CREATE INDEX IF NOT EXISTS idx_games_away_start_desc
  ON games(away_tri, scheduled_start_utc DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_subject
  ON subscriptions(telegram_user_id, subject_type, subject_key);

CREATE INDEX IF NOT EXISTS idx_subscriptions_type_subject
  ON subscriptions(subject_type, subject_key, telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_users_updated
  ON telegram_users(updated_at DESC);
