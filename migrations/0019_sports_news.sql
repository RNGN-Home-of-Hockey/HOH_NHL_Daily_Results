PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sports_news (
  news_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'sports_ru',
  source_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  body_text TEXT,
  published_at TEXT,
  topic TEXT NOT NULL DEFAULT 'nhl',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, source_key),
  UNIQUE (source, source_url)
);

CREATE INDEX IF NOT EXISTS idx_sports_news_published
  ON sports_news(published_at DESC, news_id DESC);

CREATE TABLE IF NOT EXISTS sports_news_players (
  news_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (news_id, player_id),
  FOREIGN KEY (news_id) REFERENCES sports_news(news_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sports_news_players_player
  ON sports_news_players(player_id, news_id DESC);

CREATE TABLE IF NOT EXISTS sports_news_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (news_id) REFERENCES sports_news(news_id) ON DELETE CASCADE,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sports_news_comments_news
  ON sports_news_comments(news_id, deleted, created_at ASC, comment_id ASC);

CREATE TABLE IF NOT EXISTS sports_player_sources (
  player_id INTEGER PRIMARY KEY,
  sports_slug TEXT NOT NULL,
  source_url TEXT NOT NULL,
  next_page INTEGER NOT NULL DEFAULT 1,
  backfill_done INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0,1)),
  last_scanned_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sports_player_sources_scan
  ON sports_player_sources(backfill_done, last_scanned_at, player_id);

INSERT INTO sports_player_sources(player_id,sports_slug,source_url,next_page,backfill_done)
VALUES(8471214,'alexander-ovechkin','https://www.sports.ru/hockey/person/alexander-ovechkin/news/',1,0)
ON CONFLICT(player_id) DO UPDATE SET
  sports_slug=excluded.sports_slug,
  source_url=excluded.source_url;
