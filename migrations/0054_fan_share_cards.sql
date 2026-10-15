-- «Мои итоги» as a picture for a Telegram story (package 3 of the owner's list, 2026-10-15): the app draws the card, uploads it
-- here, and Telegram takes it from a public address. Kept 7 days (an old story does not need its picture any more).
CREATE TABLE IF NOT EXISTS fan_share_cards (
  card_id TEXT PRIMARY KEY,                -- random, the public address of the picture
  telegram_user_id INTEGER NOT NULL,
  period TEXT NOT NULL,                    -- "month" | "season"
  mime TEXT NOT NULL,                      -- image/png | image/jpeg
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fan_share_cards_created ON fan_share_cards(created_at);
