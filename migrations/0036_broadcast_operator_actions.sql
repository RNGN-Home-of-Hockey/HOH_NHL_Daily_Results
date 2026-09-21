CREATE TABLE IF NOT EXISTS broadcast_operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_pk INTEGER NOT NULL,
  card_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('shown','hidden')),
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  headline_ru TEXT,
  stat_text_ru TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_broadcast_operator_actions_created
  ON broadcast_operator_actions(id DESC);

CREATE INDEX IF NOT EXISTS idx_broadcast_operator_actions_game
  ON broadcast_operator_actions(game_pk,id DESC);
