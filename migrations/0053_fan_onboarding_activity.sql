-- The game of the fans, package 2 of the owner's list (2026-10-15):
--   the first visit asks for the favourite team, players and what the person likes («Результаты», «Трансляции», «Прогнозы и
--   ставки»); the achievements count the days in a row in the app, the broadcasts opened and the fresh news read.
ALTER TABLE fan_profiles ADD COLUMN interests TEXT;     -- JSON array: ["results","streams","bets"]
ALTER TABLE fan_profiles ADD COLUMN onboarded_at TEXT;  -- when the first-visit questions were answered or skipped

CREATE TABLE IF NOT EXISTS fan_activity (
  telegram_user_id INTEGER NOT NULL,
  day TEXT NOT NULL,                       -- the Moscow date of the visit
  opens INTEGER NOT NULL DEFAULT 0,        -- the app opened that day
  streams INTEGER NOT NULL DEFAULT 0,      -- broadcasts opened from the app
  news INTEGER NOT NULL DEFAULT 0,         -- fresh news (≤ 48 hours) opened
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, day),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);
