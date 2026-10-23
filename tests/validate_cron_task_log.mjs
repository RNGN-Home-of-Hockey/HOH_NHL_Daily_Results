// The scheduled runs leave a trace, and the live Winline odds have a backup.
// Nights of 19–21 Oct 2026: the every-minute run stopped finishing its Winline sync for hours (Winline answered fine),
// the live odds went stale and the live cards of every commentator disappeared; nothing in the database said why.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { markCronStart, pruneCronTaskRuns, trackCronTask } from "../cloudflare-worker/src/cron-task-log.js";
import { BACKUP_STALE_MS, runWinlineLiveBackup, runWinlineLiveFeedMaintenance } from "../cloudflare-worker/src/winline-live-feed-maintenance.js";

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(name, dir), "utf8"));
  const stmt = (sql, args = []) => ({
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
    run: async () => { raw.prepare(sql).run(...args); return {}; },
  });
  return { raw, prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } };
}
const quiet = (fn) => async (...a) => { const e = console.error; console.error = () => {}; try { return await fn(...a); } finally { console.error = e; } };
const rows = (db) => db.raw.prepare("SELECT cron,task,ok,note FROM cron_task_runs ORDER BY id").all().map((x) => ({ ...x }));

// ---- the task log
{
  const db = makeDb(), env = { DB: db };
  await markCronStart(env, "* * * * *");
  await trackCronTask(env, "* * * * *", "winline_live", async () => ({ ok: true, skipped: false, mapped_games: 2, feed_attempts: [{ big: "x".repeat(5000) }] }));
  await quiet(trackCronTask)(env, "* * * * *", "notifications", async () => { throw new Error("D1_ERROR: boom"); });
  const r = rows(db);
  assert.deepEqual(r.map((x) => [x.task, x.ok]), [["invocation", 1], ["winline_live", 1], ["notifications", 0]]);
  assert.equal(r[1].note, '{"ok":true,"skipped":false,"mapped_games":2}', "a short result, not the whole payload");
  assert.match(r[2].note, /D1_ERROR: boom/, "the error text is kept");
  db.raw.prepare("INSERT INTO cron_task_runs(started_at,cron,task,ms,ok) VALUES(?,?,?,?,?)").run(new Date(Date.now() - 8 * 864e5).toISOString(), "* * * * *", "old", 1, 1);
  await pruneCronTaskRuns(env);
  assert.equal(rows(db).some((x) => x.task === "old"), false, "rows older than 7 days go away");
  // a broken log never breaks the task
  await quiet(trackCronTask)({ DB: { prepare: () => { throw new Error("no such table"); } } }, "* * * * *", "x", async () => 1);
}

// ---- the Winline backup and the error row
const NOW = Date.parse("2026-10-21T23:50:00Z");
const xml = `<Winline><Sport Name="Ice Hockey" Id="4"><Country Id="1"><Tournament Name="NHL" Id="7"><Match Id="9001" Team1="Buffalo Sabres" Team2="Philadelphia Flyers" MatchDate="2026-10-21T23:30:00Z" MatchUrl="https://winline.ru/plus/9001"><line freetext="Next Goal" name1="1" odd1="1.91" name2="2" odd2="2.05"></line></Match></Tournament></Country></Sport></Winline>`;
const okFeed = async () => ({ ok: true, status: 200, text: async () => xml });
function liveDb({ lastSyncAgoMs = null, live = true } = {}) {
  const db = makeDb();
  db.raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)")
    .run(2026020153, "20262027", 2, "2026-10-21T23:30:00Z", live ? "LIVE" : "FINAL", "BUF", "PHI");
  if (lastSyncAgoMs != null) db.raw.prepare("INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)")
    .run("winline_live_feed_sync_state", JSON.stringify({ fetched_at: new Date(NOW - lastSyncAgoMs).toISOString(), live_games: 1 }));
  return db;
}
{
  // no live games: the backup does nothing and does not wait
  let waited = 0;
  const r = await runWinlineLiveBackup({ DB: liveDb({ live: false }) }, { now: () => NOW, wait: async () => { waited++; }, fetchImpl: okFeed });
  assert.equal(r.reason, "no_live_games"); assert.equal(waited, 0);
}
{
  // the every-minute sync works (last one 30 s ago): the backup never runs
  const calls = [];
  const r = await runWinlineLiveBackup({ DB: liveDb({ lastSyncAgoMs: 30e3 }) }, { now: () => NOW, wait: async () => {}, fetchImpl: async (u) => { calls.push(u); return okFeed(); } });
  assert.equal(r.reason, "main_sync_fresh"); assert.equal(calls.length, 0, "no Winline request at all");
  // 60 s is late for the every-minute run but not yet a breakdown: the backup still leaves it alone
  const late = await runWinlineLiveBackup({ DB: liveDb({ lastSyncAgoMs: 60e3 }) }, { now: () => NOW, wait: async () => {}, fetchImpl: async (u) => { calls.push(u); return okFeed(); } });
  assert.equal(late.reason, "main_sync_fresh"); assert.equal(calls.length, 0);
}
{
  // the every-minute sync stopped (last one 5 min ago): the backup takes over, and a minute later sees its own fresh sync
  let t = NOW;
  const db = liveDb({ lastSyncAgoMs: 5 * 60e3 });
  const r = await runWinlineLiveBackup({ DB: db }, { now: () => t, wait: async () => { t += 30e3; }, fetchImpl: okFeed });
  assert.equal(r.reason, "took_over"); assert.equal(r.mapped_games, 1);
  assert.equal(r.runs[0].skipped, false); assert.equal(r.runs[1].skipped, true, "30 s after its own sync it waits");
  const log = db.raw.prepare("SELECT attempts_json FROM winline_live_sync_log").all();
  assert.equal(log.length, 1);
  const state = JSON.parse(db.raw.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key='winline_live_feed_sync_state'").get().meta_value);
  assert.equal(state.source, "backup", "the state says who synced");
  assert.ok(BACKUP_STALE_MS > 60e3 && BACKUP_STALE_MS < 120e3, "the backup steps in after more than a minute of silence, before two");
}
{
  // a game that cannot be written is reported with its error; the run itself goes on
  const db = liveDb({ lastSyncAgoMs: 5 * 60e3 });
  const broken = { prepare: db.prepare, batch: async () => { throw new Error("D1_ERROR: too many requests"); } };
  const r = await quiet(runWinlineLiveFeedMaintenance)({ DB: broken }, { nowMs: NOW, fetchImpl: okFeed });
  assert.equal(r.mapped_games, 0); assert.match(r.failed_games[0].error, /too many requests/);
  const log = db.raw.prepare("SELECT games_json, attempts_json FROM winline_live_sync_log").all();
  assert.equal(log.length, 1, "the failure is in the log");
  assert.match(JSON.parse(log[0].attempts_json).find((x) => x.key === "game_error").error, /too many requests/);
  assert.equal(JSON.parse(log[0].games_json)[0].s, "write_error");
}
{
  // a sync that breaks before any game (the events cannot even be read) leaves a sync_error row and throws
  const db = liveDb({ lastSyncAgoMs: 5 * 60e3 });
  const broken = { prepare: (sql) => { if (sql.includes("FROM winline_events WHERE game_pk IN")) throw new Error("D1_ERROR: overloaded"); return db.prepare(sql); }, batch: db.batch };
  await assert.rejects(runWinlineLiveFeedMaintenance({ DB: broken }, { nowMs: NOW, fetchImpl: okFeed }), /overloaded/);
  const log = db.raw.prepare("SELECT games_json, attempts_json FROM winline_live_sync_log").all();
  assert.equal(log.length, 1, "the failure is in the log");
  const a = JSON.parse(log[0].attempts_json).find((x) => x.key === "sync_error");
  assert.equal(a.stage, "persist"); assert.match(a.error, /overloaded/);
  assert.equal(JSON.parse(log[0].games_json)[0].s, "sync_error");
}

// ---- night of 22→23 Oct 2026: Winline gave live games NEW event ids mid-match; the write broke UNIQUE(game_pk),
// the batch of all games rolled back every minute and no game got live odds for hours
{
  const xml2 = `<Winline><Sport Name="Ice Hockey" Id="4"><Country Id="1"><Tournament Name="NHL" Id="7">`
    + `<Match Id="9001" Team1="Buffalo Sabres" Team2="Philadelphia Flyers" MatchDate="2026-10-21T23:30:00Z" MatchUrl="https://winline.ru/plus/9001"><line freetext="Next Goal" name1="1" odd1="1.91" name2="2" odd2="2.05"></line></Match>`
    + `<Match Id="9002" Team1="Ottawa Senators" Team2="Florida Panthers" MatchDate="2026-10-21T23:30:00Z" MatchUrl="https://winline.ru/plus/9002"><line freetext="Next Goal" name1="1" odd1="2.40" name2="2" odd2="1.60"></line></Match>`
    + `</Tournament></Country></Sport></Winline>`;
  const twoGames = () => {
    const db = liveDb({ lastSyncAgoMs: 5 * 60e3 });
    db.raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)")
      .run(2026020154, "20262027", 2, "2026-10-21T23:30:00Z", "LIVE", "OTT", "FLA");
    // BUF–PHI is already stored under the pre-match event 8001; the live feed now calls it 9001
    db.raw.prepare("INSERT INTO winline_events(winline_event_id,game_pk,status) VALUES(?,?,?)").run("8001", 2026020153, "prematch");
    return db;
  };
  const feed2 = async () => ({ ok: true, status: 200, text: async () => xml2 });
  {
    const db = twoGames();
    const r = await runWinlineLiveFeedMaintenance({ DB: db }, { nowMs: NOW, fetchImpl: feed2 });
    assert.equal(r.mapped_games, 2, "both games get their odds"); assert.deepEqual(r.failed_games, []);
    const ev = db.raw.prepare("SELECT winline_event_id,game_pk,status,raw_json FROM winline_events ORDER BY game_pk").all();
    assert.deepEqual(ev.map((e) => [e.winline_event_id, e.game_pk, e.status]), [["8001", 2026020153, "live"], ["9002", 2026020154, "live"]], "one event per game, the known one kept");
    assert.equal(JSON.parse(ev[0].raw_json).feed_event_id, "9001", "the new id of Winline is noted");
    assert.ok(db.raw.prepare("SELECT COUNT(*) n FROM winline_markets WHERE winline_event_id='8001' AND is_live=1").get().n > 0, "the live lines sit under the known event");
    assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM winline_markets WHERE winline_event_id='9001'").get().n, 0);
  }
  {
    // one game that cannot be written does not stop the other
    const db = twoGames();
    const poisoned = { prepare: db.prepare, batch: async (list) => { if (list.some((s) => (s.args || []).includes(2026020154))) throw new Error("D1_ERROR: poison"); return db.batch(list); } };
    const r = await quiet(runWinlineLiveFeedMaintenance)({ DB: poisoned }, { nowMs: NOW, fetchImpl: feed2 });
    assert.equal(r.mapped_games, 1); assert.deepEqual(r.failed_games.map((f) => f.game_pk), [2026020154]);
    assert.ok(db.raw.prepare("SELECT COUNT(*) n FROM winline_markets WHERE winline_event_id='8001' AND is_live=1").get().n > 0, "BUF–PHI still written");
    const g = Object.fromEntries(JSON.parse(db.raw.prepare("SELECT games_json FROM winline_live_sync_log ORDER BY id DESC").get().games_json).map((x) => [x.pk, x.s]));
    assert.deepEqual(g, { 2026020153: "ok", 2026020154: "write_error" }, "the log says which game failed");
  }
}

// ---- the real scheduled handler: every task of the every-minute run leaves a row, the */2 run has the backup
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline test"); };
  const { default: worker } = await import("../cloudflare-worker/src/worker-entry.js");
  const db = makeDb();
  const env = { DB: db, WINLINE_FEED_SYNC_ENABLED: "1", TELEGRAM_LIVE_NOTIFICATIONS_ENABLED: "1" };
  const run = async (cron) => { const p = []; await worker.scheduled({ cron, scheduledTime: NOW }, env, { waitUntil: (x) => p.push(x) }); await Promise.allSettled(p); };
  await quiet(run)("* * * * *");
  const tasks = new Set(rows(db).filter((x) => x.cron === "* * * * *").map((x) => x.task));
  for (const t of ["invocation", "live_score", "telegram_poll", "notifications", "winline_live", "closing_archive"]) assert.ok(tasks.has(t), "row for " + t);
  await quiet(run)("*/2 * * * *");
  assert.ok(rows(db).some((x) => x.cron === "*/2 * * * *" && x.task === "winline_live_backup"), "the */2 run has the backup");
  globalThis.fetch = realFetch;
}

console.log("validate_cron_task_log: OK");
