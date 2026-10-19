// /broadcast portal: played games stay in the list, and the page works in in-app browsers.
// Regressions of 2026-10-19 (audit 2026-10-10, findings 3 and 4):
// (3) ~1200 future games of the season filled LIMIT 100, so the games of the last 7 days never came through;
// (4) the operator name was asked with window.prompt(), which throws in Telegram/OBS/embedded browsers, and one
//     try/catch turned it into «Не удалось загрузить Data Core» for the whole page.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { handleBroadcastRequest } from "../cloudflare-worker/src/broadcast-dashboard-v2.js";

// ---------- (3) the game list ----------
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE games(game_pk INTEGER PRIMARY KEY,season_id TEXT,game_type INTEGER,scheduled_start_utc TEXT,game_state TEXT,
      home_tri TEXT,away_tri TEXT,home_score INTEGER,away_score INTEGER,current_period INTEGER,period_type TEXT,venue_name TEXT);
    CREATE TABLE teams(tri_code TEXT,name_en TEXT,name_ru TEXT,logo_url TEXT);
    CREATE TABLE players(player_id INTEGER);
    CREATE TABLE broadcast_operator_leases(game_pk INTEGER,operator_id TEXT,operator_name TEXT,expires_at TEXT);
    CREATE TABLE broadcast_cards(card_id TEXT,game_pk INTEGER,status TEXT,shown_at TEXT);
    CREATE TABLE broadcast_queue_summaries(game_pk INTEGER,strong_count INTEGER,priced_count INTEGER,total_count INTEGER,top_air_score REAL,generated_at TEXT);
    CREATE TABLE broadcast_insight_history(game_pk INTEGER);
  `);
  const db = {
    raw,
    prepare: (sql) => ({
      all: async () => ({ results: raw.prepare(sql).all().map((x) => ({ ...x })) }),
      first: async () => { const x = raw.prepare(sql).get(); return x ? { ...x } : null; },
    }),
  };
  return db;
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const H = 3600e3, D = 24 * H, now = Date.now();
let pk = 2026020000;
function addGame(db, startMs, state, { history = false, type = 2, periodType = "REG" } = {}) {
  const id = ++pk;
  db.raw.prepare("INSERT INTO games VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "20262027", type, iso(startMs), state, "NYR", "ANA", state === "FUT" ? 0 : 3, state === "FUT" ? 0 : 2, 3, periodType, "Arena");
  if (history) db.raw.prepare("INSERT INTO broadcast_insight_history VALUES(?)").run(id);
  return id;
}
async function listOf(db) {
  const r = await handleBroadcastRequest(new Request("https://x.test/api/broadcast/games"), { DB: db }, "/api/broadcast/games");
  assert.equal(r.status, 200);
  return r.json();
}
const isFinal = (g) => ["FINAL", "OFF"].includes(String(g.game_state).toUpperCase());

{
  const db = makeDb();
  const live = addGame(db, now - 1 * H, "LIVE");
  const near = Array.from({ length: 12 }, (_, i) => addGame(db, now + 6 * H + i * 10 * H, "FUT"));
  const far = Array.from({ length: 150 }, (_, i) => addGame(db, now + 8 * D + i * 2 * H, "FUT"));
  const finals = Array.from({ length: 6 }, (_, i) => addGame(db, now - (i + 1) * 20 * H, i === 2 ? "OFF" : "FINAL", { history: true, periodType: i === 0 ? "OT" : "REG" }));
  const noHistory = addGame(db, now - 3 * D, "FINAL");
  const tooOld = addGame(db, now - 8 * D, "FINAL", { history: true });

  const d = await listOf(db);
  const ids = d.games.map((g) => g.game_pk);
  assert.equal(ids[0], live, "a live game comes first");
  for (const id of near) assert.ok(ids.includes(id), "every game of the next 7 days is listed");
  assert.deepEqual(d.games.filter(isFinal).map((g) => g.game_pk), finals, "played games of the last 7 days are listed, newest first");
  assert.ok(!ids.includes(noHistory), "a played game without a pre-match archive is not listed (as before)");
  assert.ok(!ids.includes(tooOld), "games older than 7 days are not listed");
  const farListed = far.filter((id) => ids.includes(id));
  assert.deepEqual(farListed, far.slice(0, 8), "beyond 7 days only the nearest games needed to reach 20 upcoming");
  assert.equal(d.counts.games, d.games.length, "the counter matches the list");
}

{
  // a break without games (All-Star, Olympics): the next 20 games are still offered
  const db = makeDb();
  const far = Array.from({ length: 30 }, (_, i) => addGame(db, now + 10 * D + i * 3 * H, "FUT"));
  const d = await listOf(db);
  assert.deepEqual(d.games.map((g) => g.game_pk), far.slice(0, 20));
}

// ---------- (4) the page in an in-app browser ----------
const pageHtml = await (await handleBroadcastRequest(new Request("https://x.test/broadcast"), {}, "/broadcast")).text();
const appJs = await (await handleBroadcastRequest(new Request("https://x.test/broadcast/app.js"), {}, "/broadcast/app.js")).text();
assert.doesNotMatch(appJs, /\b(prompt|alert|confirm)\(/, "the portal must not depend on browser dialogs");

const UPCOMING = { game_pk: 2026020137, season_id: "20262027", game_type: 2, scheduled_start_utc: iso(now + 5 * H), game_state: "FUT", away_tri: "ANA", home_tri: "NYR", away_score: 0, home_score: 0 };
const PLAYED = { game_pk: 2026020136, season_id: "20262027", game_type: 2, scheduled_start_utc: iso(now - 14 * H), game_state: "OFF", period_type: "OT", away_tri: "CAR", home_tri: "CGY", away_score: 2, home_score: 3 };
const detail = (g) => ({ ok: true, game: { ...g, away_name_ru: "Гости", home_name_ru: "Хозяева" }, periods: [], team_stats: [], top_players: [], events: [], cards: [], featured_cards: [], persisted_cards: [] });

async function openPage({ failList = false, failGame = 0, storageThrows = false } = {}) {
  const writes = [];
  const dom = new JSDOM(pageHtml.replace(/<script[\s\S]*?<\/script>/g, ""), { url: "https://x.test/broadcast", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const blocked = () => { throw new Error("prompt() is not supported."); };
  window.prompt = blocked; window.alert = blocked; window.confirm = blocked;
  if (storageThrows) Object.defineProperty(window, "localStorage", { get() { throw new window.DOMException("denied", "SecurityError"); } });
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  window.fetch = async (url, opts = {}) => {
    const path = new URL(url, "https://x.test").pathname;
    const method = (opts.method || "GET").toUpperCase();
    if (method !== "GET") {
      writes.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
      return json(path.includes("/leases/") ? { ok: true, lease: { ...JSON.parse(opts.body || "{}"), expires_at: iso(now + 90e3) } } : { ok: true });
    }
    if (path === "/api/broadcast/games") return failList ? json({ ok: false }, 500) : json({ ok: true, counts: { games: 2 }, games: [UPCOMING, PLAYED] });
    const one = /^\/api\/broadcast\/games\/(\d+)$/.exec(path);
    if (one) {
      if (Number(one[1]) === failGame) return json({ ok: false }, 500);
      return json(detail([UPCOMING, PLAYED].find((g) => g.game_pk === Number(one[1]))));
    }
    if (path === "/api/broadcast/state") return json({ ok: true, on_air: null });
    if (path.startsWith("/api/broadcast/pregame/")) return json({ ok: true, cards: [], summary: {} });
    if (path.startsWith("/api/broadcast/operator/actions")) return json({ ok: true, actions: [] });
    return json({ ok: false }, 404);
  };
  window.eval(appJs);
  const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5)); };
  await settle();
  return { window, writes, settle, $: (s) => window.document.querySelector(s), close: () => window.close() };
}
const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

for (const storageThrows of [false, true]) {
  const p = await openPage({ storageThrows });
  assert.doesNotMatch(text(p.$("#hero")), /Не удалось/, "the page loads although dialogs" + (storageThrows ? " and storage" : "") + " are blocked");
  assert.match(text(p.$("#hero")), /ANA/, "the first upcoming game is opened");
  assert.match(text(p.$("#opname")), /Оператор [0-9A-F]{4}/, "a default operator name is shown");
  const lease = p.writes.find((w) => w.path === "/api/broadcast/operator/leases/2026020137");
  assert.ok(lease && /^Оператор /.test(lease.body.operator_name), "the lease is taken with the default name");
  const groups = [...p.window.document.querySelectorAll(".gamegroup")].map((d) => d.dataset.type);
  assert.deepEqual(groups, ["2", "final"], "played games get their own group");
  assert.match(text(p.$('.gamegroup[data-type="final"]')), /CAR · CGY.*ФИНАЛ · ОТ/, "a played game shows its result");
  assert.equal(text(p.$("#counts")), "ближайшие: 1 · сыгранные за 7 дней: 1");

  // the name is typed in the page; the lease is renewed with it
  p.$("#opname-edit").click();
  const input = p.$("#opname-input");
  input.value = "Иван";
  input.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter" }));
  await p.settle();
  assert.match(text(p.$("#opname")), /Иван/);
  assert.equal(p.writes.filter((w) => w.path.endsWith("/2026020137") && w.method === "POST").at(-1).body.operator_name, "Иван");

  // a played game opens from its group
  p.$('.gamegroup[data-type="final"] .game').click();
  await p.settle();
  assert.match(text(p.$("#hero")), /CAR.*2:3.*CGY/, "a played game opens");

  // copying the OBS address without clipboard access shows the address instead of a dialog
  p.$("#overlay-copy").click();
  await p.settle();
  assert.equal(p.$("#overlay-url")?.value, "https://x.test/broadcast/overlay?game=2026020136");
  p.close();
}

{
  // one broken game: say which, offer a retry, keep the list
  const p = await openPage({ failGame: 2026020137 });
  assert.match(text(p.$("#hero")), /Не удалось загрузить матч · HTTP 500/);
  assert.ok(p.$("#retry"), "a retry button is offered");
  assert.equal(p.window.document.querySelectorAll(".game").length, 2, "the list stays usable");
  p.$('.gamegroup[data-type="final"] .game').click();
  await p.settle();
  assert.match(text(p.$("#hero")), /CAR.*CGY/, "another game opens after a failed one");
  p.close();
}

{
  const p = await openPage({ failList: true });
  assert.match(text(p.$("#hero")), /Не удалось загрузить список матчей · HTTP 500/);
  assert.ok(p.$("#retry"));
  p.close();
}

console.log("validate_broadcast_game_list: OK");
