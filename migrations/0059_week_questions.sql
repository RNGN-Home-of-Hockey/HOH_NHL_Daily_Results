-- «Вопрос недели» (the owner, 2026-10-19: «вопрос недели… напишите по одной команде, куда его обменяют… комментаторы подсвечивались бы
-- отдельно… сделаем графику с прогнозов»).
--   week_questions     an admin asks in the bot (/week): a team of the NHL as the answer (kind 'team', plus own variants like
--                      «Останется» in options_json) or own variants only (kind 'options'); open → closed → settled (the right answer known)
--   week_answers       one answer per person; an admin may type in the answer a commentator gave in the chat (entered_by);
--                      xp = 30 for the right answer once the question is settled (it counts for the level, not for the tables of the picks)
--   app_admin_invites  an admin added by @nick before that person opened the bot becomes an admin on the first admin command
CREATE TABLE IF NOT EXISTS week_questions (
  question_id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'options')),
  options_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'settled', 'hidden')),
  answer TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_week_questions_status ON week_questions(status, created_at);

CREATE TABLE IF NOT EXISTS week_answers (
  question_id INTEGER NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  answer TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  entered_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (question_id, telegram_user_id),
  FOREIGN KEY (question_id) REFERENCES week_questions(question_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_week_answers_user ON week_answers(telegram_user_id);

CREATE TABLE IF NOT EXISTS app_admin_invites (
  username TEXT PRIMARY KEY,
  invited_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
