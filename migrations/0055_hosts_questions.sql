-- The hosts of Home of Hockey in the game of the fans and the questions to them (package 3 of the owner's list, 2026-10-15).
--   app_hosts       the hosts with a public profile (their picks, accuracy, «сравнить со мной», «зрители против ведущих»);
--                   an admin adds them in the bot: /host_add @ник Имя Фамилия
--   host_questions  «Задай вопрос ведущим»: the questions of the fans; the level of the asker puts a question higher in /questions
CREATE TABLE IF NOT EXISTS app_hosts (
  telegram_user_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  added_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS host_questions (
  question_id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'picked', 'answered', 'hidden')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_host_questions_queue ON host_questions(status, level DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_host_questions_user ON host_questions(telegram_user_id, created_at);
