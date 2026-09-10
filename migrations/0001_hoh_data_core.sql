PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  tri_code TEXT PRIMARY KEY,
  nhl_team_id INTEGER UNIQUE,
  franchise_id INTEGER,
  name_en TEXT NOT NULL,
  name_ru TEXT,
  location_en TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  logo_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS players (
  player_id INTEGER PRIMARY KEY,
  first_name_en TEXT,
  last_name_en TEXT,
  full_name_en TEXT NOT NULL,
  full_name_ru TEXT,
  current_team_tri TEXT,
  position_code TEXT,
  sweater_number INTEGER,
  shoots_catches TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (current_team_tri) REFERENCES teams(tri_code)
);

CREATE TABLE IF NOT EXISTS games (
  game_pk INTEGER PRIMARY KEY,
  season_id TEXT NOT NULL,
  game_type INTEGER,
  scheduled_start_utc TEXT NOT NULL,
  game_state TEXT NOT NULL,
  home_tri TEXT NOT NULL,
  away_tri TEXT NOT NULL,
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  current_period INTEGER,
  period_type TEXT,
  venue_name TEXT,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (home_tri) REFERENCES teams(tri_code),
  FOREIGN KEY (away_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_games_start
  ON games(scheduled_start_utc);

CREATE INDEX IF NOT EXISTS idx_games_teams
  ON games(home_tri, away_tri);

CREATE INDEX IF NOT EXISTS idx_games_season_state
  ON games(season_id, game_state);

CREATE TABLE IF NOT EXISTS period_scores (
  game_pk INTEGER NOT NULL,
  period_number INTEGER NOT NULL,
  period_type TEXT NOT NULL,
  home_goals INTEGER NOT NULL DEFAULT 0,
  away_goals INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_pk, period_number, period_type),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_events (
  event_key TEXT PRIMARY KEY,
  game_pk INTEGER NOT NULL,
  event_id INTEGER,
  sort_order INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  period_number INTEGER,
  period_type TEXT,
  time_in_period TEXT,
  time_remaining TEXT,
  team_tri TEXT,
  home_score INTEGER,
  away_score INTEGER,
  description TEXT,
  x_coord REAL,
  y_coord REAL,
  details_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_events_game_sort
  ON game_events(game_pk, sort_order);

CREATE INDEX IF NOT EXISTS idx_game_events_type
  ON game_events(game_pk, event_type);

CREATE INDEX IF NOT EXISTS idx_game_events_team
  ON game_events(team_tri, event_type);

CREATE TABLE IF NOT EXISTS event_players (
  event_key TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_key, player_id, role, ordinal),
  FOREIGN KEY (event_key) REFERENCES game_events(event_key) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

CREATE INDEX IF NOT EXISTS idx_event_players_player
  ON event_players(player_id, role);

CREATE TABLE IF NOT EXISTS team_game_stats (
  game_pk INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  is_home INTEGER NOT NULL CHECK (is_home IN (0, 1)),
  goals INTEGER NOT NULL DEFAULT 0,
  shots INTEGER,
  shot_attempts INTEGER,
  blocked_shots INTEGER,
  hits INTEGER,
  pim INTEGER,
  giveaways INTEGER,
  takeaways INTEGER,
  faceoff_pct REAL,
  power_play_goals INTEGER,
  power_play_opportunities INTEGER,
  shorthanded_goals INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, team_tri),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_team_game_stats_team
  ON team_game_stats(team_tri, game_pk);

CREATE TABLE IF NOT EXISTS player_game_stats (
  game_pk INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  shots INTEGER,
  shot_attempts INTEGER,
  hits INTEGER,
  blocked_shots INTEGER,
  pim INTEGER,
  plus_minus INTEGER,
  faceoff_pct REAL,
  toi_seconds INTEGER,
  power_play_goals INTEGER,
  power_play_points INTEGER,
  shorthanded_goals INTEGER,
  game_winning_goals INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, player_id),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_player_game_stats_player
  ON player_game_stats(player_id, game_pk);

CREATE INDEX IF NOT EXISTS idx_player_game_stats_team
  ON player_game_stats(team_tri, game_pk);

CREATE TABLE IF NOT EXISTS standings_snapshots (
  snapshot_date TEXT NOT NULL,
  team_tri TEXT NOT NULL,
  games_played INTEGER,
  wins INTEGER,
  losses INTEGER,
  ot_losses INTEGER,
  points INTEGER,
  regulation_wins INTEGER,
  goals_for INTEGER,
  goals_against INTEGER,
  division_name TEXT,
  conference_name TEXT,
  division_rank INTEGER,
  conference_rank INTEGER,
  league_rank INTEGER,
  raw_json TEXT,
  PRIMARY KEY (snapshot_date, team_tri),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  sync_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_type TEXT NOT NULL,
  scope_key TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_type_started
  ON sync_runs(sync_type, started_at);

CREATE TABLE IF NOT EXISTS insights (
  insight_id TEXT PRIMARY KEY,
  game_pk INTEGER,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  insight_type TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  numerator REAL,
  denominator REAL,
  value_num REAL,
  value_unit TEXT,
  sample_size INTEGER,
  filters_json TEXT NOT NULL,
  evidence_game_pks_json TEXT NOT NULL,
  text_ru TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'candidate',
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_insights_game_score
  ON insights(game_pk, status, score);

CREATE INDEX IF NOT EXISTS idx_insights_subject
  ON insights(subject_type, subject_key, insight_type);

CREATE TABLE IF NOT EXISTS broadcast_cards (
  card_id TEXT PRIMARY KEY,
  game_pk INTEGER NOT NULL,
  insight_id TEXT,
  display_order INTEGER,
  headline_ru TEXT NOT NULL,
  stat_text_ru TEXT NOT NULL,
  source_note_ru TEXT,
  suggested_market_type TEXT,
  suggested_market_subject TEXT,
  manual_odds REAL,
  odds_is_demo INTEGER NOT NULL DEFAULT 1 CHECK (odds_is_demo IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'draft',
  shown_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (insight_id) REFERENCES insights(insight_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_broadcast_cards_game
  ON broadcast_cards(game_pk, status, display_order);

CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  notify_pregame INTEGER NOT NULL DEFAULT 1 CHECK (notify_pregame IN (0, 1)),
  notify_start INTEGER NOT NULL DEFAULT 1 CHECK (notify_start IN (0, 1)),
  notify_goal INTEGER NOT NULL DEFAULT 1 CHECK (notify_goal IN (0, 1)),
  notify_assist INTEGER NOT NULL DEFAULT 0 CHECK (notify_assist IN (0, 1)),
  notify_period_end INTEGER NOT NULL DEFAULT 0 CHECK (notify_period_end IN (0, 1)),
  notify_final INTEGER NOT NULL DEFAULT 1 CHECK (notify_final IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (telegram_user_id, subject_type, subject_key),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subject
  ON subscriptions(subject_type, subject_key);

CREATE TABLE IF NOT EXISTS notification_log (
  notification_key TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  notification_type TEXT NOT NULL,
  subject_type TEXT,
  subject_key TEXT,
  game_pk INTEGER,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_json TEXT,
  PRIMARY KEY (notification_key, telegram_user_id),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_log_user_sent
  ON notification_log(telegram_user_id, sent_at);

CREATE TABLE IF NOT EXISTS winline_events (
  winline_event_id TEXT PRIMARY KEY,
  game_pk INTEGER UNIQUE,
  status TEXT,
  starts_at TEXT,
  deeplink TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS winline_markets (
  winline_market_id TEXT PRIMARY KEY,
  winline_event_id TEXT NOT NULL,
  market_type TEXT NOT NULL,
  subject_type TEXT,
  subject_key TEXT,
  outcome_name TEXT,
  odds REAL,
  deeplink TEXT,
  is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  raw_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (winline_event_id) REFERENCES winline_events(winline_event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_winline_markets_event_type
  ON winline_markets(winline_event_id, market_type, active);
