PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_user_profiles (
  telegram_user_id INTEGER PRIMARY KEY,
  display_username TEXT COLLATE NOCASE,
  profile_name TEXT,
  birth_date TEXT,
  city TEXT,
  hockey_since_year INTEGER,
  favorite_team_tri TEXT,
  favorite_player TEXT,
  theme_mode TEXT NOT NULL DEFAULT 'light' CHECK(theme_mode IN ('dark','light')),
  avatar_mime TEXT,
  avatar_base64 TEXT,
  avatar_bytes INTEGER,
  username_changed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (favorite_team_tri) REFERENCES teams(tri_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_profiles_username
  ON app_user_profiles(display_username)
  WHERE display_username IS NOT NULL AND TRIM(display_username) <> '';

CREATE TABLE IF NOT EXISTS sports_player_news_exact (
  player_id INTEGER NOT NULL,
  news_id INTEGER NOT NULL,
  source_page_url TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id,news_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE,
  FOREIGN KEY (news_id) REFERENCES sports_news(news_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sports_player_news_exact_player
  ON sports_player_news_exact(player_id,news_id DESC);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
 ('app_user_profiles.version','1',CURRENT_TIMESTAMP),
 ('sports_player_news_exact.version','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
