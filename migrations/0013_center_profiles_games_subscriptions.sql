PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS player_profile_meta (
  player_id INTEGER PRIMARY KEY,
  full_name_ru TEXT,
  sports_ru_url TEXT,
  eliteprospects_url TEXT,
  pronunciation_url TEXT,
  pronunciation_source TEXT,
  primary_country_code TEXT,
  countries_json TEXT,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_profile_meta_country
  ON player_profile_meta(primary_country_code);

CREATE TABLE IF NOT EXISTS subscription_preferences (
  subscription_id INTEGER PRIMARY KEY,
  notify_pregame INTEGER NOT NULL DEFAULT 1 CHECK (notify_pregame IN (0,1)),
  notify_start INTEGER NOT NULL DEFAULT 0 CHECK (notify_start IN (0,1)),
  notify_goal INTEGER NOT NULL DEFAULT 1 CHECK (notify_goal IN (0,1)),
  notify_assist INTEGER NOT NULL DEFAULT 0 CHECK (notify_assist IN (0,1)),
  notify_point INTEGER NOT NULL DEFAULT 0 CHECK (notify_point IN (0,1)),
  notify_period_end INTEGER NOT NULL DEFAULT 0 CHECK (notify_period_end IN (0,1)),
  notify_final INTEGER NOT NULL DEFAULT 1 CHECK (notify_final IN (0,1)),
  notify_odds INTEGER NOT NULL DEFAULT 0 CHECK (notify_odds IN (0,1)),
  notify_trends INTEGER NOT NULL DEFAULT 0 CHECK (notify_trends IN (0,1)),
  notify_lineup INTEGER NOT NULL DEFAULT 0 CHECK (notify_lineup IN (0,1)),
  notify_injury INTEGER NOT NULL DEFAULT 0 CHECK (notify_injury IN (0,1)),
  notify_daily_digest INTEGER NOT NULL DEFAULT 0 CHECK (notify_daily_digest IN (0,1)),
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  max_pushes_per_day INTEGER NOT NULL DEFAULT 12,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(subscription_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_groups (
  group_key TEXT PRIMARY KEY,
  title_ru TEXT NOT NULL,
  description_ru TEXT,
  country_code TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscription_group_members (
  group_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (group_key, subject_type, subject_key),
  FOREIGN KEY (group_key) REFERENCES subscription_groups(group_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscription_group_members_subject
  ON subscription_group_members(subject_type, subject_key);

INSERT OR IGNORE INTO subscription_groups (group_key,title_ru,description_ru,country_code,sort_order)
VALUES ('RUS_NHL','Все россияне в НХЛ','Одна подписка на события российских игроков НХЛ','RUS',10);

CREATE TABLE IF NOT EXISTS game_profile_meta (
  game_pk INTEGER PRIMARY KEY,
  stage_code TEXT,
  stage_label_ru TEXT,
  stage_color TEXT,
  home_team_game_no INTEGER,
  away_team_game_no INTEGER,
  playoff_round INTEGER,
  playoff_series_no INTEGER,
  playoff_game_no INTEGER,
  catalog_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_profile_meta_stage
  ON game_profile_meta(stage_code, playoff_round);
