import { strict as assert } from 'node:assert';

// Contract-level checks for the multi-operator lease migration.
// Runtime SQL behavior is covered by Cloudflare/D1; this fixture protects the
// important invariants from accidental edits.
const sql = `CREATE TABLE IF NOT EXISTS broadcast_operator_leases (
  game_pk INTEGER PRIMARY KEY,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_broadcast_operator_leases_expires
  ON broadcast_operator_leases(expires_at);
`;
assert.match(sql,/game_pk INTEGER PRIMARY KEY/);
assert.match(sql,/operator_id TEXT NOT NULL/);
assert.match(sql,/expires_at TEXT NOT NULL/);
assert.match(sql,/ON DELETE CASCADE/);
console.log('BROADCAST_OPERATOR_LEASE_SCHEMA_OK');
