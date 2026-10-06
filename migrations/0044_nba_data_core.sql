PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nba_teams (
  team_id INTEGER PRIMARY KEY,
  abbreviation TEXT NOT NULL,
  team_name TEXT,
  last_seen_game_date TEXT,
  last_seen_game_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nba_teams_abbreviation
  ON nba_teams(abbreviation);

CREATE TABLE IF NOT EXISTS nba_players (
  player_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  current_team_id INTEGER,
  current_team_abbr TEXT,
  last_seen_game_date TEXT,
  last_seen_game_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (current_team_id) REFERENCES nba_teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_nba_players_team
  ON nba_players(current_team_id, current_team_abbr);

CREATE TABLE IF NOT EXISTS nba_games (
  game_id TEXT PRIMARY KEY,
  season_year TEXT NOT NULL,
  season_type TEXT NOT NULL,
  game_date TEXT NOT NULL,
  home_team_id INTEGER,
  away_team_id INTEGER,
  home_team_abbr TEXT,
  away_team_abbr TEXT,
  home_score INTEGER,
  away_score INTEGER,
  game_status TEXT NOT NULL DEFAULT 'FINAL',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (home_team_id) REFERENCES nba_teams(team_id),
  FOREIGN KEY (away_team_id) REFERENCES nba_teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_nba_games_date
  ON nba_games(game_date, game_id);

CREATE INDEX IF NOT EXISTS idx_nba_games_season
  ON nba_games(season_year, season_type, game_date);

CREATE INDEX IF NOT EXISTS idx_nba_games_teams
  ON nba_games(home_team_id, away_team_id, game_date);

CREATE TABLE IF NOT EXISTS nba_team_game_stats (
  game_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  season_year TEXT NOT NULL,
  season_type TEXT NOT NULL,
  game_date TEXT NOT NULL,
  team_abbr TEXT NOT NULL,
  team_name TEXT,
  matchup TEXT,
  wl TEXT,
  is_home INTEGER NOT NULL CHECK (is_home IN (0, 1)),
  minutes REAL,
  fgm INTEGER,
  fga INTEGER,
  fg_pct REAL,
  fg3m INTEGER,
  fg3a INTEGER,
  fg3_pct REAL,
  ftm INTEGER,
  fta INTEGER,
  ft_pct REAL,
  oreb INTEGER,
  dreb INTEGER,
  reb INTEGER,
  ast INTEGER,
  tov INTEGER,
  stl INTEGER,
  blk INTEGER,
  blka INTEGER,
  pf INTEGER,
  pfd INTEGER,
  pts INTEGER,
  plus_minus REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, team_id),
  FOREIGN KEY (game_id) REFERENCES nba_games(game_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES nba_teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_nba_team_game_stats_team_date
  ON nba_team_game_stats(team_id, game_date DESC, game_id DESC);

CREATE INDEX IF NOT EXISTS idx_nba_team_game_stats_season
  ON nba_team_game_stats(season_year, season_type, game_date);

CREATE TABLE IF NOT EXISTS nba_player_game_stats (
  game_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  season_year TEXT NOT NULL,
  season_type TEXT NOT NULL,
  game_date TEXT NOT NULL,
  player_name TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  team_abbr TEXT NOT NULL,
  team_name TEXT,
  matchup TEXT,
  wl TEXT,
  minutes REAL,
  fgm INTEGER,
  fga INTEGER,
  fg_pct REAL,
  fg3m INTEGER,
  fg3a INTEGER,
  fg3_pct REAL,
  ftm INTEGER,
  fta INTEGER,
  ft_pct REAL,
  oreb INTEGER,
  dreb INTEGER,
  reb INTEGER,
  ast INTEGER,
  tov INTEGER,
  stl INTEGER,
  blk INTEGER,
  blka INTEGER,
  pf INTEGER,
  pfd INTEGER,
  pts INTEGER,
  plus_minus REAL,
  nba_fantasy_pts REAL,
  dd2 INTEGER,
  td3 INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, player_id),
  FOREIGN KEY (game_id) REFERENCES nba_games(game_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES nba_players(player_id),
  FOREIGN KEY (team_id) REFERENCES nba_teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_player_date
  ON nba_player_game_stats(player_id, game_date DESC, game_id DESC);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_team_date
  ON nba_player_game_stats(team_id, game_date DESC, game_id DESC);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_season
  ON nba_player_game_stats(season_year, season_type, game_date);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_points
  ON nba_player_game_stats(player_id, pts, game_date);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_rebounds
  ON nba_player_game_stats(player_id, reb, game_date);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_assists
  ON nba_player_game_stats(player_id, ast, game_date);

CREATE INDEX IF NOT EXISTS idx_nba_player_game_stats_threes
  ON nba_player_game_stats(player_id, fg3m, game_date);

CREATE TABLE IF NOT EXISTS nba_sync_manifest (
  season_year TEXT NOT NULL,
  season_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'stats.nba.com',
  player_rows INTEGER NOT NULL DEFAULT 0,
  team_rows INTEGER NOT NULL DEFAULT 0,
  game_rows INTEGER NOT NULL DEFAULT 0,
  first_game_date TEXT,
  last_game_date TEXT,
  player_payload_sha256 TEXT,
  team_payload_sha256 TEXT,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season_year, season_type)
);
