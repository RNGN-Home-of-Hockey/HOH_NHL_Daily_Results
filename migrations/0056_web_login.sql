-- Signing in on the website (outside Telegram) through the bot @HOH_NHL_Center_bot: cloudflare-worker/src/telegram-center-web-login.js.
-- Only hashes are kept: the code of the bot link and the browser's session key never reach the database.
CREATE TABLE IF NOT EXISTS web_logins (
  login_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,        -- sha256 of the code in t.me/<bot>?start=login_<code>
  check_code TEXT NOT NULL,              -- the 4 digits shown on the site and in the bot
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,              -- ISO, 10 minutes after created_at
  telegram_user_id INTEGER,              -- set when the fan presses «✅ Войти» in the bot
  first_name TEXT,
  username TEXT,
  confirmed_at TEXT,
  declined_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_web_logins_expires ON web_logins(expires_at);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,           -- sha256 of the key the browser keeps
  telegram_user_id INTEGER NOT NULL,
  first_name TEXT,
  username TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL               -- ISO, 180 days after created_at
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
