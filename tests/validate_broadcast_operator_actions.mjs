import { strict as assert } from 'node:assert';

const migration=\`CREATE TABLE IF NOT EXISTS broadcast_operator_actions (
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
);\`;

assert.match(migration,/CHECK\(action IN \('shown','hidden'\)\)/);
assert.match(migration,/operator_name TEXT NOT NULL/);
assert.match(migration,/headline_ru TEXT/);
assert.match(migration,/FOREIGN KEY \(game_pk\)/);
console.log('BROADCAST_OPERATOR_ACTION_LOG_SCHEMA_OK');
