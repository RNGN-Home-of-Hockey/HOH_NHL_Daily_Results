-- Tennis database (SQLite): players, tournaments, matches, per-match statistics.
-- Column names follow BOLSHE-Live-Center, the first source; `source` says where a row came from,
-- because each source has its own licence and a row must stay traceable to it.

CREATE TABLE IF NOT EXISTS import_run (
  run_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_json TEXT
);

CREATE TABLE IF NOT EXISTS player (
  player_id TEXT PRIMARY KEY,
  tour TEXT,
  name_ru TEXT, name_ru_short TEXT, name_latin TEXT,
  country_code TEXT, is_russian INTEGER, birth_date TEXT,
  singles_rank INTEGER, singles_points INTEGER, doubles_rank INTEGER,
  elo REAL, elo_hard REAL, elo_clay REAL, elo_grass REAL,
  fs_id TEXT, wta_id TEXT, atp_id TEXT, espn_id TEXT, ta_id TEXT, wikidata_id TEXT,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_fs ON player (fs_id);
CREATE INDEX IF NOT EXISTS idx_player_wta ON player (wta_id);

CREATE TABLE IF NOT EXISTS tournament (
  tournament_key TEXT PRIMARY KEY,
  name TEXT, category TEXT, tour TEXT, level TEXT, discipline TEXT,
  surface TEXT, tournament TEXT, country TEXT, first_seen TEXT, prize TEXT,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match (
  match_id TEXT PRIMARY KEY,
  tournament_key TEXT,
  start_at TEXT, end_at TEXT, date_msk TEXT, status TEXT, note TEXT,
  p1_fs_id TEXT, p2_fs_id TEXT, p1_name TEXT, p2_name TEXT,
  sets_p1 INTEGER, sets_p2 INTEGER, sets_json TEXT, winner INTEGER, is_doubles INTEGER,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_p1 ON match (p1_fs_id);
CREATE INDEX IF NOT EXISTS idx_match_p2 ON match (p2_fs_id);
CREATE INDEX IF NOT EXISTS idx_match_tournament ON match (tournament_key);

-- One row per player per match. Counts, not percentages, so that they add up over a season.
CREATE TABLE IF NOT EXISTS match_player_stats (
  match_id TEXT NOT NULL, fs_id TEXT NOT NULL, opp_fs_id TEXT,
  played_at TEXT NOT NULL, surface TEXT, won INTEGER NOT NULL,
  sets_won INTEGER, sets_lost INTEGER, deciding INTEGER,
  aces INTEGER, df INTEGER,
  first_won INTEGER, first_total INTEGER, second_won INTEGER, second_total INTEGER,
  bp_saved_won INTEGER, bp_saved_total INTEGER,
  ret1_won INTEGER, ret1_total INTEGER, ret2_won INTEGER, ret2_total INTEGER,
  bp_conv_won INTEGER, bp_conv_total INTEGER,
  winners INTEGER, ue INTEGER, net_won INTEGER, net_total INTEGER,
  sv_pts_won INTEGER, sv_pts_total INTEGER, rt_pts_won INTEGER, rt_pts_total INTEGER,
  tot_pts_won INTEGER, tot_pts_total INTEGER,
  sv_games_won INTEGER, sv_games_total INTEGER, rt_games_won INTEGER, rt_games_total INTEGER,
  tb_won INTEGER, tb_total INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (match_id, fs_id)
);
CREATE INDEX IF NOT EXISTS idx_mps_player ON match_player_stats (fs_id, played_at);

CREATE TABLE IF NOT EXISTS match_odds (
  match_id TEXT PRIMARY KEY, wl_id TEXT, pre1 REAL, pre2 REAL, pre_at TEXT,
  live1 REAL, live2 REAL, live_at TEXT, hcap REAL, hcap1 REAL, hcap2 REAL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_snapshot (
  tour TEXT NOT NULL, discipline TEXT NOT NULL, ranking_date TEXT NOT NULL, player_id TEXT NOT NULL,
  rank INTEGER, prev_rank INTEGER, points INTEGER, tournaments INTEGER, source TEXT NOT NULL,
  PRIMARY KEY (tour, discipline, ranking_date, player_id)
);

CREATE TABLE IF NOT EXISTS elo_snapshot (
  player_id TEXT NOT NULL, rated_on TEXT NOT NULL,
  elo REAL, elo_rank INTEGER, elo_hard REAL, elo_clay REAL, elo_grass REAL, source TEXT NOT NULL,
  PRIMARY KEY (player_id, rated_on)
);

-- Season, surface and tournament numbers are always computed from the matches, never stored.
DROP VIEW IF EXISTS player_tournament_stats;
DROP VIEW IF EXISTS player_season_stats;
DROP VIEW IF EXISTS player_match;
CREATE VIEW player_match AS
SELECT s.*, substr(s.played_at, 1, 4) AS season, p.player_id, p.tour, p.name_latin, p.name_ru,
       m.tournament_key, t.name AS tournament_name, t.level AS tournament_level
FROM match_player_stats s
LEFT JOIN player p ON p.fs_id = s.fs_id
LEFT JOIN match m ON m.match_id = s.match_id
LEFT JOIN tournament t ON t.tournament_key = m.tournament_key;

CREATE VIEW player_season_stats AS
SELECT fs_id, name_latin, tour, season, surface,
       COUNT(*) AS matches, SUM(won) AS wins, COUNT(*) - SUM(won) AS losses,
       SUM(aces) AS aces, SUM(df) AS df,
       SUM(first_won) AS first_won, SUM(first_total) AS first_total,
       SUM(second_won) AS second_won, SUM(second_total) AS second_total,
       SUM(bp_saved_won) AS bp_saved_won, SUM(bp_saved_total) AS bp_saved_total,
       SUM(bp_conv_won) AS bp_conv_won, SUM(bp_conv_total) AS bp_conv_total,
       SUM(sv_games_won) AS sv_games_won, SUM(sv_games_total) AS sv_games_total,
       SUM(rt_games_won) AS rt_games_won, SUM(rt_games_total) AS rt_games_total,
       SUM(tb_won) AS tb_won, SUM(tb_total) AS tb_total
FROM player_match
GROUP BY fs_id, season, surface;

CREATE VIEW player_tournament_stats AS
SELECT fs_id, name_latin, tournament_key, tournament_name, season,
       COUNT(*) AS matches, SUM(won) AS wins, COUNT(*) - SUM(won) AS losses,
       SUM(aces) AS aces, SUM(df) AS df
FROM player_match
WHERE tournament_key IS NOT NULL
GROUP BY fs_id, tournament_key, season;
