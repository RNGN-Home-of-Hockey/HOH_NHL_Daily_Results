-- The ratings of the hockey game EA SPORTS NHL (now NHL 27) for the player portrait (telegram-center-v31-player-profile.js):
-- the main groups of characteristics as the game shows them, one row per NHL player. EA publishes the ~300 best rated players;
-- the Worker reads them once a week. Only the group averages and the overall are kept, not the full sheet of the game.
CREATE TABLE IF NOT EXISTS player_game_ratings (
  player_id INTEGER PRIMARY KEY,         -- the NHL id
  game TEXT NOT NULL,                    -- "NHL 27"
  ea_id INTEGER,
  ea_name TEXT,
  team_tri TEXT,
  position TEXT,                         -- as the game writes it: CEN, LW, RW, LD, RD, G
  overall INTEGER NOT NULL,
  groups_json TEXT NOT NULL,             -- {"skating":91,"offense":94,...} or the goalie groups
  fetched_at TEXT NOT NULL               -- ISO
);
