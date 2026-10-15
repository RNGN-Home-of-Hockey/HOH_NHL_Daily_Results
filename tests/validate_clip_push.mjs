// The clip index pushed by the highlights server: some Cloudflare data centres (Frankfurt) cannot reach the Moscow server, so the
// server pushes index.json and covers.json and every data centre reads the same copy from D1. On SQLite with the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { PUSH_PATH, PUSH_FRESH_MS, handleClipIndexPush, pushedIndex, pushedCovers, clearPushMemory } from "../cloudflare-worker/src/telegram-center-v26-clip-push.js";
import { handleTelegramCenterV26, loadGoalsPayload } from "../cloudflare-worker/src/telegram-center-v26-goals.js";
import { loadCoverUrls } from "../cloudflare-worker/src/telegram-center-v26-covers.js";

const MIG = new URL("../migrations/", import.meta.url);
const createOf = (file, table) => fs.readFileSync(new URL(file, MIG), "utf8").match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
for (const t of ["players"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } }, HOH_CLIPS_BASE: "https://clips.test" };

const INDEX = {
  version: 1, generated_at: "2026-10-15T07:34:00Z",
  games: [{ game_pk: 2026020107, date: "20261014", kind: "live", away: "DAL", home: "COL", goals: [
    { event_id: 78, period: 1, away_score: 0, home_score: 1, scorer_id: 8475768, team: "COL", duration: 62, orig: { path: "live/20261014/dal-col/a.mp4" }, light: { path: "live/20261014/dal-col/tg/a.mp4" } },
  ] }],
};
const COVERS = { version: 1, covers: { 2026020107: 1792010806 } };
const SERVER = "109.172.113.187";
const push = (body, { ip = SERVER, gzip = false, method = "POST", e = env } = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "Content-Type": "application/json", "cf-connecting-ip": ip };
  if (gzip) headers["Content-Encoding"] = "gzip";
  const init = { method, headers };
  if (method === "POST") init.body = gzip ? gzipSync(Buffer.from(text)) : text;
  return handleClipIndexPush(new Request(`https://x.test${PUSH_PATH}`, init), e);
};
const row = (key) => raw.prepare("SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=?").get(key);

// ---- 1) who may push, and what ---------------------------------------------------------------------------------------------------
assert.equal((await push({ index: INDEX }, { method: "GET" })).status, 405);
assert.equal((await push({ index: INDEX }, { e: {} })).status, 503);
assert.equal((await push({ index: INDEX }, { ip: "1.2.3.4" })).status, 403, "only the address of the clip server");
assert.equal((await push({ index: INDEX }, { ip: "" })).status, 403);
assert.equal((await push("{nope")).status, 400);
assert.equal((await push({ index: { games: "x" } })).status, 400, "an index has a list of games");
assert.equal(row("clip_index_push_v1"), undefined, "nothing stored from the refused pushes");
const ok = await (await push({ index: INDEX, covers: COVERS }, { gzip: true })).json();
assert.deepEqual(ok, { ok: true, games: 1, covers: 1, bytes: JSON.stringify(INDEX).length }, "the gzip body of the server");
assert.deepEqual(JSON.parse(row("clip_index_push_v1").meta_value), INDEX);
assert.deepEqual(JSON.parse(row("clip_covers_push_v1").meta_value), COVERS);
assert.equal((await push({ index: INDEX }, { ip: "5.6.7.8", e: { ...env, CLIP_PUSH_IPS: "5.6.7.8, 9.9.9.9" } })).status, 200, "the allowed addresses can be changed without a new release");

// ---- 2) the copy is read by everybody while it is fresh --------------------------------------------------------------------------------
clearPushMemory();
assert.deepEqual(await pushedIndex(env), INDEX);
assert.deepEqual(await pushedCovers(env), COVERS);
const later = Date.now() + PUSH_FRESH_MS + 60000;
clearPushMemory();
assert.equal(await pushedIndex(env, { now: later }), null, "the server stopped pushing for 10 minutes: the copy is not trusted, the direct fetch is tried");
clearPushMemory();
assert.equal(await pushedIndex({}), null, "no database: null, not a crash");

// ---- 3) the home page, the match screen and the covers read the copy without asking the server --------------------------------------
clearPushMemory();
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (String(url).includes("api-web.nhle.com")) {
    return new Response(JSON.stringify({ gameState: "OFF", startTimeUTC: "2026-10-15T00:30:00Z", awayTeam: { abbrev: "DAL", score: 3 }, homeTeam: { abbrev: "COL", score: 2 },
      summary: { scoring: [{ periodDescriptor: { number: 1, periodType: "REG" }, goals: [{ eventId: 78, playerId: 8475768, firstName: { default: "Jaden" }, lastName: { default: "Schwartz" }, teamAbbrev: { default: "COL" }, timeInPeriod: "01:59", awayScore: 0, homeScore: 1 }] }] } }), { status: 200 });
  }
  throw new Error(`the clip server must not be asked: ${url}`);
};
try {
  const covers = await loadCoverUrls(env);
  assert.deepEqual(covers, { 2026020107: "https://clips.test/covers/2026020107.jpg?v=1792010806" });
  const goals = await loadGoalsPayload(env, 2026020107);
  assert.equal(goals.clips.server_ok, true, "the pushed index counts as the server");
  assert.equal(goals.goals[0].clip.state, "ready");
  assert.equal(goals.cover_url, "https://clips.test/covers/2026020107.jpg?v=1792010806");
  assert.ok(asked.every((u) => !u.includes("clips.test")), "not a single request to the clip server");
  // the route
  const refused = await handleTelegramCenterV26(new Request(`https://x.test${PUSH_PATH}`, { method: "POST", headers: { "cf-connecting-ip": "1.1.1.1" }, body: "{}" }), env, PUSH_PATH);
  assert.equal(refused.status, 403, "the push is reachable through the match screen router");
} finally {
  globalThis.fetch = realFetch;
}
const home = fs.readFileSync(new URL("../cloudflare-worker/src/telegram-center-v27-home.js", import.meta.url), "utf8");
assert.match(home, /loadIndex: async \(base, env\) => \(await pushedIndex\(env\)\) \|\| loadClipIndex\(base\),/, "the home page reads the copy first");
assert.match(home, /deps\.loadIndex\(base, env\)/);

// ---- 4) the server side ------------------------------------------------------------------------------------------------------------
const script = fs.readFileSync(new URL("../deploy/app/hoh-clip-push.py", import.meta.url), "utf8");
assert.match(script, /api\/telegram-center-v26\/clip-index/);
assert.match(script, /"Content-Encoding": "gzip"/);
assert.match(script, /RESEND_SECONDS = 300/, "resent every 5 minutes even unchanged (the Worker trusts a copy for 10)");
assert.ok(!/token|secret|password/i.test(script.replace(/No secrets\./, "")), "no secret in the public script");
assert.match(fs.readFileSync(new URL("../deploy/app/hoh-clip-push.timer", import.meta.url), "utf8"), /OnUnitInactiveSec=30s/);
assert.match(fs.readFileSync(new URL("../deploy/app/app.caddy", import.meta.url), "utf8"), /reverse_proxy https:\/\/hoh-nhl-daily-results\.rngn\.workers\.dev/);

console.log("clip push validation passed");
