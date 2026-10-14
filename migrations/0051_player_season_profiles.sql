-- The portrait of a player (the hexagon on his page): for every axis the share of the players of his position he is better than,
-- computed every 6 hours from the NHL stats reports of the whole league.
CREATE TABLE IF NOT EXISTS player_season_profiles (
  season_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  pos_group TEXT NOT NULL,          -- F forwards, D defencemen, G goalies
  games INTEGER NOT NULL DEFAULT 0,
  axes_json TEXT NOT NULL,          -- {"attack": 93, "passing": 71, ...} percentiles 0..100
  values_json TEXT NOT NULL,        -- the numbers behind them (per game)
  peers INTEGER NOT NULL DEFAULT 0, -- how many players of the position were compared
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season_id, player_id)
);
