CREATE TABLE IF NOT EXISTS nba_winline_events (
  event_id INTEGER PRIMARY KEY,
  championship_id INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  team1_name TEXT NOT NULL,
  team2_name TEXT NOT NULL,
  team1_abbr TEXT,
  team2_abbr TEXT,
  source_url TEXT NOT NULL,
  market_count INTEGER NOT NULL DEFAULT 0,
  player_props_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_nba_winline_events_start
  ON nba_winline_events(starts_at, event_id);

CREATE TABLE IF NOT EXISTS nba_winline_markets (
  market_key TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  market_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_name TEXT,
  entity_abbr TEXT,
  selection_side TEXT NOT NULL,
  line_value REAL,
  odds REAL,
  market_label TEXT,
  selection_label TEXT,
  fetched_at TEXT NOT NULL,
  raw_json TEXT,
  FOREIGN KEY (event_id) REFERENCES nba_winline_events(event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nba_winline_markets_event
  ON nba_winline_markets(event_id, market_type, entity_abbr);

CREATE INDEX IF NOT EXISTS idx_nba_winline_markets_type
  ON nba_winline_markets(market_type, entity_type, fetched_at);

CREATE TABLE IF NOT EXISTS nba_winline_sync (
  source TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  market_count INTEGER NOT NULL DEFAULT 0,
  player_props_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT
);
