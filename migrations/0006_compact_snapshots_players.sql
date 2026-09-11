PRAGMA foreign_keys = ON;

-- Compact pregame team snapshots. One row per game/team/window, so Broadcast can
-- read league ranks and advanced 5v5 context without scanning historical tables.
CREATE TABLE IF NOT EXISTS pregame_team_snapshots (
  game_pk INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  window_games INTEGER NOT NULL CHECK (window_games IN (5,10,20)),
  sample_size INTEGER NOT NULL,
  league_teams INTEGER,
  gf_pg REAL,
  ga_pg REAL,
  goal_diff_pg REAL,
  total_pg REAL,
  corsi_pct REAL,
  fenwick_pct REAL,
  p2_diff_pg REAL,
  rank_gf INTEGER,
  rank_ga INTEGER,
  rank_goal_diff INTEGER,
  rank_total INTEGER,
  rank_corsi INTEGER,
  rank_fenwick INTEGER,
  rank_p2_diff INTEGER,
  advanced_sample_size INTEGER,
  advanced_league_teams INTEGER,
  xgf_pct_5v5 REAL,
  xgf60_5v5 REAL,
  xga60_5v5 REAL,
  corsi_pct_5v5 REAL,
  fenwick_pct_5v5 REAL,
  pdo_5v5 REAL,
  gsax_5v5 REAL,
  rank_xgf_pct_5v5 INTEGER,
  rank_xgf60_5v5 INTEGER,
  rank_xga60_5v5 INTEGER,
  rank_corsi_pct_5v5 INTEGER,
  rank_fenwick_pct_5v5 INTEGER,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, team_tri, window_games),
  FOREIGN KEY (game_pk) REFERENCES games(game_pk) ON DELETE CASCADE,
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code),
  FOREIGN KEY (opponent_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_pregame_team_snapshots_game
  ON pregame_team_snapshots(game_pk, window_games, team_tri);

CREATE INDEX IF NOT EXISTS idx_pregame_team_snapshots_team
  ON pregame_team_snapshots(team_tri, game_pk, window_games);

-- Current compact skater windows. Historical game rows remain local; D1 only
-- receives the aggregates needed to generate current player cards cheaply.
CREATE TABLE IF NOT EXISTS player_rolling_snapshots (
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  position_code TEXT,
  window_key TEXT NOT NULL,
  as_of_utc TEXT NOT NULL,
  games INTEGER NOT NULL,
  goals INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  points INTEGER NOT NULL,
  shots INTEGER,
  hits INTEGER,
  blocked_shots INTEGER,
  pim INTEGER,
  plus_minus INTEGER,
  toi_seconds INTEGER,
  power_play_goals INTEGER,
  games_with_goal INTEGER NOT NULL DEFAULT 0,
  games_with_point INTEGER NOT NULL DEFAULT 0,
  games_with_2plus_points INTEGER NOT NULL DEFAULT 0,
  goals_pg REAL,
  assists_pg REAL,
  points_pg REAL,
  shots_pg REAL,
  toi_seconds_pg REAL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, window_key),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_player_rolling_team_window
  ON player_rolling_snapshots(team_tri, window_key, points_pg DESC);

CREATE TABLE IF NOT EXISTS player_opponent_splits (
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  games INTEGER NOT NULL,
  goals INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  points INTEGER NOT NULL,
  shots INTEGER,
  games_with_goal INTEGER NOT NULL DEFAULT 0,
  games_with_point INTEGER NOT NULL DEFAULT 0,
  games_with_2plus_points INTEGER NOT NULL DEFAULT 0,
  goals_pg REAL,
  assists_pg REAL,
  points_pg REAL,
  shots_pg REAL,
  last_game_utc TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, opponent_tri, scope_key),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code),
  FOREIGN KEY (opponent_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_player_opponent_lookup
  ON player_opponent_splits(player_id, opponent_tri, scope_key);

CREATE TABLE IF NOT EXISTS goalie_rolling_snapshots (
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  window_key TEXT NOT NULL,
  as_of_utc TEXT NOT NULL,
  games INTEGER NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  ot_losses INTEGER NOT NULL DEFAULT 0,
  saves INTEGER,
  shots_against INTEGER,
  goals_against INTEGER,
  save_pct REAL,
  goals_against_pg REAL,
  shutouts INTEGER NOT NULL DEFAULT 0,
  toi_seconds INTEGER,
  toi_seconds_pg REAL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, window_key),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_goalie_rolling_team_window
  ON goalie_rolling_snapshots(team_tri, window_key, save_pct DESC);

CREATE TABLE IF NOT EXISTS goalie_opponent_splits (
  player_id INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  games INTEGER NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  ot_losses INTEGER NOT NULL DEFAULT 0,
  saves INTEGER,
  shots_against INTEGER,
  goals_against INTEGER,
  save_pct REAL,
  goals_against_pg REAL,
  shutouts INTEGER NOT NULL DEFAULT 0,
  last_game_utc TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, opponent_tri, scope_key),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code),
  FOREIGN KEY (opponent_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_goalie_opponent_lookup
  ON goalie_opponent_splits(player_id, opponent_tri, scope_key);
