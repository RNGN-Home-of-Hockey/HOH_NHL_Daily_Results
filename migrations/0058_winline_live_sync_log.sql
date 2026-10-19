-- One row per live Winline sync (the every-minute cron while NHL games are on, winline-live-feed-maintenance.js):
-- for every live NHL game whether Winline's public feeds had it with odds, without odds (suspended) or not at all,
-- and how each feed answered. Answers «why did the live cards disappear at 03:15?» after the game.
-- The sync itself deletes rows older than 14 days.
CREATE TABLE IF NOT EXISTS winline_live_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TEXT NOT NULL,              -- ISO, the sync time
  live_games INTEGER NOT NULL,           -- candidate games: live, or starting within 30 min
  mapped_games INTEGER NOT NULL,         -- games that got priced live lines in this sync
  games_json TEXT NOT NULL,              -- [{pk,m,state,min,s:"ok"|"no_odds"|"absent",feeds,lines}]
  attempts_json TEXT NOT NULL            -- [{key,ok,status,bytes,nhl_events,error}] per fetched feed
);
CREATE INDEX IF NOT EXISTS idx_winline_live_sync_log_at ON winline_live_sync_log(fetched_at);
