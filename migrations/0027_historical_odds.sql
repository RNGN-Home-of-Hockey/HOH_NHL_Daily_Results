PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS historical_odds_closing (
  game_pk INTEGER NOT NULL,
  source TEXT NOT NULL,
  market_key TEXT NOT NULL,
  captured_at TEXT,
  source_event_id TEXT,
  home_odds REAL,
  draw_odds REAL,
  away_odds REAL,
  bookmaker_count INTEGER,
  home_implied_prob REAL,
  draw_implied_prob REAL,
  away_implied_prob REAL,
  home_no_vig_prob REAL,
  draw_no_vig_prob REAL,
  away_no_vig_prob REAL,
  overround_pct REAL,
  raw_summary_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, source, market_key),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_historical_odds_closing_source
  ON historical_odds_closing(source, market_key, game_pk);

CREATE INDEX IF NOT EXISTS idx_historical_odds_closing_game
  ON historical_odds_closing(game_pk, market_key);

CREATE TABLE IF NOT EXISTS historical_odds_game_features (
  game_pk INTEGER NOT NULL,
  source TEXT NOT NULL,
  market_key TEXT NOT NULL,
  home_tri TEXT NOT NULL,
  away_tri TEXT NOT NULL,
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  regulation_result TEXT NOT NULL CHECK (regulation_result IN ('1','X','2')),
  home_odds REAL,
  draw_odds REAL,
  away_odds REAL,
  favorite_result TEXT CHECK (favorite_result IN ('1','X','2') OR favorite_result IS NULL),
  favorite_odds REAL,
  favorite_won INTEGER CHECK (favorite_won IN (0,1) OR favorite_won IS NULL),
  home_underdog INTEGER NOT NULL DEFAULT 0 CHECK (home_underdog IN (0,1)),
  away_underdog INTEGER NOT NULL DEFAULT 0 CHECK (away_underdog IN (0,1)),
  home_underdog_win INTEGER NOT NULL DEFAULT 0 CHECK (home_underdog_win IN (0,1)),
  away_underdog_win INTEGER NOT NULL DEFAULT 0 CHECK (away_underdog_win IN (0,1)),
  high_price_home_win INTEGER NOT NULL DEFAULT 0 CHECK (high_price_home_win IN (0,1)),
  high_price_away_win INTEGER NOT NULL DEFAULT 0 CHECK (high_price_away_win IN (0,1)),
  realized_return_home REAL,
  realized_return_draw REAL,
  realized_return_away REAL,
  closing_overround_pct REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, source, market_key),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_historical_odds_features_team_away
  ON historical_odds_game_features(away_tri, away_underdog, away_underdog_win, season_id, game_pk);

CREATE INDEX IF NOT EXISTS idx_historical_odds_features_team_home
  ON historical_odds_game_features(home_tri, home_underdog, home_underdog_win, season_id, game_pk);

CREATE INDEX IF NOT EXISTS idx_historical_odds_features_favorite
  ON historical_odds_game_features(favorite_result, favorite_won, season_id, game_pk);

CREATE TABLE IF NOT EXISTS historical_odds_team_trends (
  team_tri TEXT NOT NULL,
  source TEXT NOT NULL,
  market_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  games INTEGER NOT NULL,
  avg_home_odds REAL,
  avg_away_odds REAL,
  home_underdog_games INTEGER NOT NULL DEFAULT 0,
  home_underdog_wins INTEGER NOT NULL DEFAULT 0,
  away_underdog_games INTEGER NOT NULL DEFAULT 0,
  away_underdog_wins INTEGER NOT NULL DEFAULT 0,
  away_high_price_wins INTEGER NOT NULL DEFAULT 0,
  flat_home_roi_pct REAL,
  flat_away_roi_pct REAL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_tri, source, market_key, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_historical_odds_team_trends
  ON historical_odds_team_trends(source, market_key, scope_key, away_underdog_wins DESC);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('historical_odds.version','1',CURRENT_TIMESTAMP),
  ('historical_odds.market_contract','regular_time_1x2 closing consensus',CURRENT_TIMESTAMP),
  ('historical_odds.source_policy','licensed or expressly-permitted sources only',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
