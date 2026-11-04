-- Winline's open tennis line with its history, recorded by the worker (tennis-winline-snapshot.js).
-- A price is stored only when it changes, so the rows of a market are its history and the last one
-- before start_at is its closing price. Apart from the hockey winline_* tables, which hold one
-- current state per game; tools/tennis/winline_pull.py copies these to the local tennis database.
CREATE TABLE IF NOT EXISTS tennis_winline_fetch (
  taken_at TEXT PRIMARY KEY,
  events INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  changed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tennis_winline_event (
  wl_id TEXT PRIMARY KEY,
  circuit TEXT,
  tournament TEXT,
  team1 TEXT,
  team2 TEXT,
  team1_id TEXT,
  team2_id TEXT,
  start_at TEXT,
  url TEXT,
  is_doubles INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tennis_winline_event_start ON tennis_winline_event (start_at);
CREATE INDEX IF NOT EXISTS idx_tennis_winline_event_seen ON tennis_winline_event (last_seen);

-- value_key is value as text, '' for a market without one: a primary key cannot hold NULL safely.
CREATE TABLE IF NOT EXISTS tennis_winline_line (
  wl_id TEXT NOT NULL,
  market TEXT NOT NULL,
  value_key TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  value REAL,
  odd1 REAL,
  odd2 REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (wl_id, market, value_key, taken_at)
);
CREATE INDEX IF NOT EXISTS idx_tennis_winline_line_taken ON tennis_winline_line (taken_at);
