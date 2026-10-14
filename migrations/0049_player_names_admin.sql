-- Russian names of players: Sports.ru first, corrections of the admins on top. Admins fix a name inside the Center bot
-- (/name + a part of the English or Russian name); the correction wins over every other source and survives every refresh.
CREATE TABLE IF NOT EXISTS player_name_overrides (
  player_id INTEGER PRIMARY KEY,
  full_name_ru TEXT NOT NULL,
  previous_name_ru TEXT,
  edited_by INTEGER,
  edited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Telegram accounts that may use the admin commands of the Center bot.
CREATE TABLE IF NOT EXISTS app_admins (
  telegram_user_id INTEGER PRIMARY KEY,
  added_by INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- What an admin is doing in the bot right now (for example: waiting for the new name of a player).
CREATE TABLE IF NOT EXISTS admin_bot_state (
  telegram_user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
