-- A row per task of the scheduled runs (cron-task-log.js): when the every-minute invocation started, and for every
-- task whether it finished, how long it took and its error. A task cut off by the platform (CPU or memory limit of the
-- invocation) leaves no row — that is the signal. Added after the nights of 19–21 Oct 2026 when the live Winline odds
-- stopped for hours while Winline answered fine and nothing told why. Rows older than 7 days are deleted by the */5 run.
CREATE TABLE IF NOT EXISTS cron_task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,              -- ISO, when the task started
  cron TEXT NOT NULL,                    -- "* * * * *", "*/2 * * * *", "*/5 * * * *"
  task TEXT NOT NULL,                    -- "invocation" (start marker), "winline_live", "live_score", ...
  ms INTEGER,                            -- duration
  ok INTEGER NOT NULL,                   -- 1 finished, 0 threw
  note TEXT                              -- short result or the error text
);
CREATE INDEX IF NOT EXISTS idx_cron_task_runs_started ON cron_task_runs(started_at);
