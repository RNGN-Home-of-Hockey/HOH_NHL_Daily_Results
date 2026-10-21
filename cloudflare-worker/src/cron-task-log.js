// What the scheduled runs did, kept in D1 (cron_task_runs, migration 0060). On the nights of 19–21 Oct 2026 the
// live Winline odds stopped for hours while Winline answered fine; the platform logs were not readable and nothing
// in the database told which task of the every-minute run broke. Now:
//  - markCronStart: a row "invocation" as soon as a run starts (no row = the platform did not start it);
//  - trackCronTask: a row per task when it finishes, with its duration and a short result, or its error.
//    A task cut off by the platform (CPU or memory limit of the run) leaves no row at all.
const KEEP_DAYS = 7;

export function markCronStart(env, cron) {
  return writeRun(env, new Date().toISOString(), cron, "invocation", 0, true, null);
}

export function trackCronTask(env, cron, task, run) {
  const started = Date.now();
  return Promise.resolve()
    .then(run)
    .then(
      (result) => writeRun(env, new Date(started).toISOString(), cron, task, Date.now() - started, true, summarize(result)),
      (error) => {
        console.error(`scheduled ${task} failed`, error);
        return writeRun(env, new Date(started).toISOString(), cron, task, Date.now() - started, false, String(error?.stack || error?.message || error));
      },
    );
}

export async function pruneCronTaskRuns(env, { nowMs = Date.now() } = {}) {
  if (!env?.DB) return;
  await env.DB.prepare("DELETE FROM cron_task_runs WHERE started_at<?").bind(new Date(nowMs - KEEP_DAYS * 864e5).toISOString()).run();
}

async function writeRun(env, startedAt, cron, task, ms, ok, note) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare("INSERT INTO cron_task_runs(started_at,cron,task,ms,ok,note) VALUES(?,?,?,?,?,?)")
      .bind(startedAt, cron, task, ms, ok ? 1 : 0, note == null ? null : String(note).slice(0, 500)).run();
  } catch (error) {
    console.error("cron task log write failed", task, error);
  }
}

// a few telling fields of a task's result, not the whole payload
function summarize(result) {
  if (result == null || typeof result !== "object") return result == null ? null : String(result);
  const keep = ["ok", "skipped", "reason", "error", "live_games", "mapped_games", "markets_written", "games_written", "games_seen", "sent", "failed", "planned", "updates_processed", "games", "cards"];
  const out = {};
  for (const key of keep) if (result[key] !== undefined) out[key] = result[key];
  return JSON.stringify(out);
}
