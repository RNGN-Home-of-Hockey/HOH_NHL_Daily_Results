PRAGMA foreign_keys = ON;

-- "Кто победит?": one pick per person and game (the winner including overtime and the shootout), open until the scheduled start.
-- result/xp/settled_at are written once the game is final; reported_at once the morning message of the bot has told the result.
CREATE TABLE IF NOT EXISTS fan_predictions (
  telegram_user_id INTEGER NOT NULL,
  game_pk INTEGER NOT NULL,
  pick TEXT NOT NULL CHECK (pick IN ('home', 'away')),
  pick_tri TEXT NOT NULL,
  odds_at_pick REAL,
  game_date TEXT NOT NULL,
  season_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result TEXT CHECK (result IN ('win', 'loss', 'void')),
  xp INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  reported_at TEXT,
  PRIMARY KEY (telegram_user_id, game_pk),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fan_predictions_game
  ON fan_predictions(game_pk, pick);

CREATE INDEX IF NOT EXISTS idx_fan_predictions_unsettled
  ON fan_predictions(settled_at, game_pk);

CREATE INDEX IF NOT EXISTS idx_fan_predictions_board
  ON fan_predictions(game_date, telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_fan_predictions_season
  ON fan_predictions(season_id, telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_fan_predictions_report
  ON fan_predictions(reported_at, settled_at, telegram_user_id);

-- One row per settled game: who won, how the fans voted, the Winline odds at the start and the points of each side.
CREATE TABLE IF NOT EXISTS fan_prediction_games (
  game_pk INTEGER PRIMARY KEY,
  winner TEXT NOT NULL CHECK (winner IN ('home', 'away', 'void')),
  home_votes INTEGER NOT NULL DEFAULT 0,
  away_votes INTEGER NOT NULL DEFAULT 0,
  home_odds REAL,
  away_odds REAL,
  home_xp INTEGER,
  away_xp INTEGER,
  settled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Settings of the game for a person: the morning message of the bot can be switched off.
CREATE TABLE IF NOT EXISTS fan_profiles (
  telegram_user_id INTEGER PRIMARY KEY,
  morning_digest INTEGER NOT NULL DEFAULT 1 CHECK (morning_digest IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

INSERT INTO data_core_meta(meta_key, meta_value, updated_at)
VALUES ('telegram_center.fan_predictions_v1', '1', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = CURRENT_TIMESTAMP;
