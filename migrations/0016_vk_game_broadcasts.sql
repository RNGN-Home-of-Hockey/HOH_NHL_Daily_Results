PRAGMA foreign_keys = ON;

-- Raw HOH/VK broadcasts. Keep source records even when the automatic matcher
-- cannot yet attach them to an NHL game; this makes historical backfill auditable.
CREATE TABLE IF NOT EXISTS vk_broadcasts (
  source_key TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL DEFAULT 'vk_video',
  owner_id TEXT,
  video_id TEXT,
  title TEXT NOT NULL,
  published_at TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'recorded',
  web_url TEXT NOT NULL,
  app_url TEXT,
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  parsed_home_tri TEXT,
  parsed_away_tri TEXT,
  raw_json TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_vk_broadcasts_published
  ON vk_broadcasts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_vk_broadcasts_scheduled
  ON vk_broadcasts(scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_vk_broadcasts_teams
  ON vk_broadcasts(parsed_home_tri, parsed_away_tri);

-- One canonical HOH broadcast per NHL game. Because a game already has home_tri
-- and away_tri, one row automatically belongs to both team schedules.
CREATE TABLE IF NOT EXISTS game_vk_broadcasts (
  game_pk INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  match_method TEXT NOT NULL,
  match_confidence REAL NOT NULL DEFAULT 1.0,
  matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (source_key) REFERENCES vk_broadcasts(source_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_vk_broadcasts_source
  ON game_vk_broadcasts(source_key);
