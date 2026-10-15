// v32: the game while it is on — «Что я пропустил» and «На что поставить сейчас» on the match screen, the live line and «Сейчас в
// эфире» for the match of the day. The NHL feed is faked, D1 runs on SQLite with the tables of the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { SCRIPT_PATH, FRESH_SECONDS, recapOf, liveOffers, streakOf, hookOf, loadLivePayload, handleTelegramCenterV32 } from "../cloudflare-worker/src/telegram-center-v32-live.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

// a game in the 2nd period: COL leads 2:1, the second COL goal on the power play
const landing = (over = {}) => ({
  id: 2026020107, gameState: "LIVE", startTimeUTC: "2026-10-15T00:30:00Z",
  periodDescriptor: { number: 2, periodType: "REG" }, clock: { timeRemaining: "12:34", running: true, inIntermission: false },
  awayTeam: { abbrev: "DAL", score: 1, sog: 14 }, homeTeam: { abbrev: "COL", score: 2, sog: 19 },
  summary: {
    scoring: [
      { periodDescriptor: { number: 1, periodType: "REG" }, goals: [
        { playerId: 8476455, firstName: { default: "Gabriel" }, lastName: { default: "Landeskog" }, teamAbbrev: { default: "COL" }, timeInPeriod: "09:29", strength: "ev", awayScore: 0, homeScore: 1 },
        { playerId: 8480036, firstName: { default: "Miro" }, lastName: { default: "Heiskanen" }, teamAbbrev: { default: "DAL" }, timeInPeriod: "15:03", strength: "ev", awayScore: 1, homeScore: 1 },
      ] },
      { periodDescriptor: { number: 2, periodType: "REG" }, goals: [
        { playerId: 8475768, firstName: { default: "Jaden" }, lastName: { default: "Schwartz" }, teamAbbrev: { default: "COL" }, timeInPeriod: "04:10", strength: "pp", awayScore: 1, homeScore: 2 },
      ] },
    ],
    penalties: [
      { periodDescriptor: { number: 1 }, penalties: [{ teamAbbrev: { default: "DAL" }, duration: 2 }, { teamAbbrev: { default: "DAL" }, duration: 2 }, { teamAbbrev: { default: "COL" }, duration: 5 }] },
      { periodDescriptor: { number: 2 }, penalties: [{ teamAbbrev: { default: "DAL" }, duration: 2 }] },
    ],
  },
  ...over,
});

// ---- 1) the recap -------------------------------------------------------------------------------------------------------------
{
  const r = recapOf(landing(), new Map([[8476455, "Габриэль Ландескуг"], [8475768, "Джейден Шварц"]]));
  assert.deepEqual(r.shots, { away: 14, home: 19 });
  assert.deepEqual(r.penalties, { away: { count: 3, minutes: 6 }, home: { count: 1, minutes: 5 } });
  assert.deepEqual(r.power_play_goals, { away: 0, home: 1 });
  assert.deepEqual(r.goals.map((g) => [g.period, g.time, g.team, g.scorer, g.score_after.away, g.score_after.home]), [
    ["1-й", "09:29", "COL", "Габриэль Ландескуг", 0, 1],
    ["1-й", "15:03", "DAL", "Miro Heiskanen", 1, 1],
    ["2-й", "04:10", "COL", "Джейден Шварц", 1, 2],
  ], "the Russian name when we have it, the English one otherwise");
  assert.equal(r.last_goal.scorer, "Джейден Шварц");
  const so = recapOf(landing({ summary: { scoring: [{ periodDescriptor: { number: 5, periodType: "SO" }, goals: [{ playerId: 1, firstName: { default: "Roope" }, lastName: { default: "Hintz" }, teamAbbrev: { default: "DAL" }, timeInPeriod: "00:00", awayScore: 3, homeScore: 2 }] }] } }));
  assert.equal(so.goals[0].time, null, "a shootout goal has no clock (it is always 00:00)");
  assert.equal(so.goals[0].period, "Б");
  assert.equal(recapOf(null), null);
}

// ---- 2) the live offers and the hook --------------------------------------------------------------------------------------------
{
  const rows = [
    { market_type: "nextgoalx:4", subject_key: "DAL", outcome_name: "2", odds: 2.37 },
    { market_type: "nextgoalx:4", subject_key: "COL", outcome_name: "1", odds: 2.1 },
    { market_type: "nextgoalx:4", subject_key: null, outcome_name: "x", odds: 4.28 },
    { market_type: "nextgoalx:3", subject_key: "DAL", outcome_name: "2", odds: 9.9 }, // the goal that has been scored
    { market_type: "moneyline", subject_key: "DAL", outcome_name: "Away", odds: 2.6 },
    { market_type: "moneyline", subject_key: "COL", outcome_name: "Home", odds: 1.5 },
    { market_type: "asiantotal:2.5", outcome_name: "over", odds: 1.01 },
    { market_type: "asiantotal:4.5", outcome_name: "over", odds: 2.2 },
    { market_type: "asiantotal:5.5", outcome_name: "over", odds: 3.4 },
    { market_type: "asiantotal:4.5", outcome_name: "under", odds: 1.6 },
  ];
  const offers = liveOffers(rows, { away: "DAL", home: "COL", goals: 3 });
  assert.deepEqual(offers.map((o) => [o.kind, o.label, o.odds]), [
    ["next_goal", "Следующий гол — DAL", 2.37],
    ["next_goal", "Следующий гол — COL", 2.1],
    ["winner", "Победа DAL", 2.6],
    ["winner", "Победа COL", 1.5],
    ["total", "Тотал больше 4,5", 2.2],
  ], "the 4th goal (3 are scored), both winners, the nearest total above the goals");
  assert.deepEqual(liveOffers([], { away: "DAL", home: "COL", goals: 0 }), []);
  assert.deepEqual(streakOf(["W", "W", "W", "L", "W"]), { kind: "W", n: 3 });
  assert.deepEqual(streakOf(["L", "W"]), { kind: "L", n: 1 });
  assert.equal(streakOf([]), null);
  assert.equal(hookOf([{ tri: "DAL", streak: { kind: "W", n: 4 } }, { tri: "COL", streak: { kind: "L", n: 2 } }], { DAL: "Даллас" }), "Даллас: 4 победы подряд");
  assert.equal(hookOf([{ tri: "UTA", streak: { kind: "L", n: 5 } }, { tri: "EDM", streak: { kind: "W", n: 3 } }], { UTA: "Юта" }), "Юта: 5 поражений подряд", "the longer run");
  assert.equal(hookOf([{ tri: "UTA", streak: { kind: "L", n: 3 } }, { tri: "EDM", streak: { kind: "W", n: 3 } }], { EDM: "Эдмонтон" }), "Эдмонтон: 3 победы подряд", "a win run first when equal");
  assert.equal(hookOf([{ tri: "UTA", streak: { kind: "W", n: 2 } }]), null, "from three games only");
  assert.equal(hookOf([{ tri: "UTA", streak: { kind: "W", n: 1 } }, { tri: "EDM", streak: null }]), null);
  assert.equal(hookOf([{ tri: "TOR", streak: { kind: "W", n: 21 } }]), "TOR: 21 победа подряд");
}

// ---- 3) the payload on SQLite ---------------------------------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const createOf = (file, table) => fs.readFileSync(new URL(file, MIG), "utf8").match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
for (const t of ["teams", "players", "games", "winline_events", "winline_markets"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const env = { DB: { prepare: (sql) => stmt(sql) } };
for (const [tri, ru] of [["DAL", "Даллас Старз"], ["COL", "Колорадо Эвеланш"], ["SJS", null], ["BOS", null], ["NYR", null], ["MIN", null], ["VGK", null]]) raw.prepare("INSERT INTO teams(tri_code,name_en,name_ru) VALUES(?,?,?)").run(tri, tri, ru);
raw.prepare("INSERT INTO players(player_id,full_name_en,full_name_ru) VALUES(?,?,?)").run(8476455, "Gabriel Landeskog", "Габриэль Ландескуг");
const game = raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score) VALUES(?,?,?,?,?,?,?,?,?)");
game.run(2026020107, "20262027", 2, "2026-10-15T00:30:00Z", "LIVE", "COL", "DAL", 2, 1);
// Dallas: four wins in a row before tonight (and an older loss); Colorado: won the last one only
game.run(1, "20262027", 2, "2026-10-14T00:30:00Z", "OFF", "DAL", "COL", 3, 2);
game.run(2, "20262027", 2, "2026-10-12T00:30:00Z", "OFF", "DAL", "SJS", 5, 1);
game.run(3, "20262027", 2, "2026-10-10T00:30:00Z", "FINAL", "BOS", "DAL", 1, 4);
game.run(4, "20262027", 2, "2026-10-08T00:30:00Z", "OFF", "DAL", "NYR", 2, 1);
game.run(5, "20262027", 2, "2026-10-06T00:30:00Z", "OFF", "DAL", "MIN", 0, 3);
game.run(6, "20262027", 2, "2026-10-13T00:30:00Z", "OFF", "COL", "VGK", 4, 0);
game.run(7, "20262027", 1, "2026-10-05T00:30:00Z", "OFF", "DAL", "COL", 0, 9); // preseason, would break nothing anyway
raw.prepare("INSERT INTO winline_events(winline_event_id,game_pk,status) VALUES(?,?,?)").run("W7", 2026020107, "live");
const NOW = Date.parse("2026-10-15T01:40:00Z");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString().replace("T", " ").slice(0, 19);
const mk = raw.prepare("INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,is_live,active,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
mk.run("a", "W7", "nextgoalx:4", "team", "DAL", "2", 2.37, 1, 1, at(30));
mk.run("b", "W7", "nextgoalx:4", "team", "COL", "1", 2.1, 1, 1, at(30));
mk.run("c", "W7", "moneyline", "team", "COL", "Home", 1.5, 1, 1, at(30));
mk.run("d", "W7", "moneyline", "team", "DAL", "Away", 2.6, 1, 1, at(FRESH_SECONDS + 60)); // stale: not shown
mk.run("e", "W7", "asiantotal:4.5", "total", null, "over", 2.2, 1, 0, at(30)); // closed: not shown
mk.run("f", "W7", "asiantotal:5.5", "total", null, "over", 3.4, 1, 1, at(30));
mk.run("g", "W7", "moneyline", "team", "DAL", "Away", 1.9, 0, 1, at(30)); // pre-match: not a live price
{
  const fetched = [];
  const fetcher = async (url) => { fetched.push(url); return landing(); };
  const p = await loadLivePayload(env, 2026020107, { now: NOW, fetcher });
  assert.equal(fetched[0], "https://api-web.nhle.com/v1/gamecenter/2026020107/landing");
  assert.equal(p.live, true);
  assert.equal(p.label, "2-й период · 12:34");
  assert.deepEqual(p.score, { away: 1, home: 2 });
  assert.equal(p.recap.goals[0].scorer, "Габриэль Ландескуг", "the Russian names of our players table");
  assert.deepEqual(p.offers.map((o) => o.label), ["Следующий гол — DAL", "Следующий гол — COL", "Победа COL", "Тотал больше 5,5"], "fresh, open and live prices only");
  assert.equal(p.hook, "Даллас: 4 победы подряд", "the form before tonight");
  const before = await loadLivePayload(env, 2026020107, { now: NOW, fetcher: async () => landing({ gameState: "FUT" }) });
  assert.deepEqual([before.live, before.recap, before.offers], [false, null, []], "before the start: nothing to recap or offer");
  const over = await loadLivePayload(env, 2026020107, { now: NOW, fetcher: async () => landing({ gameState: "OFF" }) });
  assert.equal(over.live, false);
  assert.ok(over.recap, "after the game the recap is still there for the API");
  assert.deepEqual(over.offers, [], "no live prices after the game");
  const down = await loadLivePayload(env, 2026020107, { now: NOW, fetcher: async () => { throw new Error("timeout"); } });
  assert.deepEqual(down, { ok: false, error: "nhl_unavailable", status: 502 });
}

// ---- 4) the routes ---------------------------------------------------------------------------------------------------------------
const script = await (await handleTelegramCenterV32(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).text();
{
  assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
  assert.equal((await handleTelegramCenterV32(new Request(`https://x.test${SCRIPT_PATH}`, { method: "POST" }), env, SCRIPT_PATH)).status, 405);
  assert.equal(await handleTelegramCenterV32(new Request("https://x.test/api/other"), env, "/api/other"), null);
  assert.equal(await handleTelegramCenterV32(new Request("https://x.test/api/telegram-center-v32/games/abc/live"), env, "/api/telegram-center-v32/games/abc/live"), null);
  assert.equal((await handleTelegramCenterV32(new Request("https://x.test/api/telegram-center-v32/games/1/live", { method: "POST" }), env, "/api/telegram-center-v32/games/1/live")).status, 405);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v32-live.js?build=32.0"), "the script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v32-live.js") > shell.indexOf("/telegram-app/v31-player.js"), "after the player portrait");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).status, 200, "reachable through the main router");
}

// ---- 5) the screen ---------------------------------------------------------------------------------------------------------------
const PAYLOAD = {
  ok: true, game_pk: 2026020107, live: true, phase: "live", label: "2-й период · 12:34", teams: { away: "DAL", home: "COL" }, score: { away: 1, home: 2 },
  recap: recapOf(landing(), new Map([[8476455, "Габриэль Ландескуг"]])),
  offers: [{ kind: "next_goal", team: "DAL", label: "Следующий гол — DAL", odds: 2.37 }, { kind: "winner", team: "COL", label: "Победа COL", odds: 1.5 }, { kind: "total", label: "Тотал больше 5,5", odds: 3.4 }],
  hook: "Даллас: 4 победы подряд",
};
function makeApp(html, { payload = PAYLOAD, spoilers = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html class="v15Light"><head></head><body><main id="view">${html}</main></body></html>`, { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.HOHNoSpoilers = () => spoilers;
  window.HOHV15 = { api: async (url) => { calls.push(url); return payload; } };
  window.HOHV26 = { state: { gamePk: 2026020107 } };
  window.eval(script);
  return { window, document: window.document, calls };
}
{
  // the match screen of a live game: the recap and the bet right under the head
  const { window, document, calls } = makeApp('<div id="v26Root"><div id="v26Head">DAL 1 : 2 COL</div><div id="v29Match"></div><div class="v26Goals"></div></div>');
  await tick(120);
  assert.deepEqual(calls, ["/api/telegram-center-v32/games/2026020107/live"]);
  const recap = document.querySelector("[data-v32-recap]");
  assert.ok(recap, "«Что я пропустил» is there");
  assert.equal(recap.previousElementSibling.id, "v26Head", "right under the score");
  assert.equal(text(recap.querySelector(".v32Top")), "Что я пропустил 2-й период · 12:34");
  assert.deepEqual([...recap.querySelectorAll(".v32Stats div")].map(text), ["14–19 броски в створ", "3–1 удаления", "0–1 голы в большинстве"]);
  assert.deepEqual([...recap.querySelectorAll(".v32Goals li")].map(text), ["1-й 09:29 Габриэль Ландескуг COL 0:1", "1-й 15:03 Miro Heiskanen DAL 1:1", "2-й 04:10 Jaden Schwartz (бол.) COL 1:2"]);
  const bet = document.querySelector("[data-v32-bet]");
  assert.equal(bet.previousElementSibling, recap, "the bet under the recap");
  assert.equal(text(bet.querySelector(".v32BTop")), "На что поставить сейчас");
  assert.equal(text(bet.querySelector(".v32Hook")), "🔥 Даллас: 4 победы подряд");
  assert.deepEqual([...bet.querySelectorAll(".v32Chip")].map(text), ["Следующий гол — DAL 2.37", "Победа COL 1.50", "Тотал больше 5,5 3.40"]);
  assert.ok([...bet.querySelectorAll(".v32Chip")].every((a) => a.getAttribute("href") === "/go/winline?game_pk=2026020107" && a.target === "_blank"));
  assert.ok(document.getElementById("v26Root").classList.contains("v32Live"), "the line before the start gives way to the live prices");
  assert.match(document.getElementById("v32css").textContent, /\.v32Live \.v26Wl\{display:none!important\}/);
  // a redraw of the screen keeps one copy of each
  document.getElementById("v26Root").append(document.createElement("i"));
  await tick(150);
  assert.equal(document.querySelectorAll("[data-v32-recap]").length, 1);
  assert.equal(document.querySelectorAll("[data-v32-bet]").length, 1);
  assert.equal(calls.length, 1, "not asked again before 20 seconds");
  window.close();
}
{
  // a game that is not on, the no-spoilers mode, no live prices: nothing (or only the recap)
  const notLive = makeApp('<div id="v26Root"><div id="v26Head"></div></div>', { payload: { ...PAYLOAD, live: false, offers: [] } });
  await tick(120);
  assert.equal(notLive.document.querySelector("[data-v32-recap]"), null, "a game that is over has its own screen of goals");
  notLive.window.close();
  const hidden = makeApp('<div id="v26Root"><div id="v26Head"></div></div>', { spoilers: true });
  await tick(120);
  assert.equal(hidden.document.querySelector("[data-v32-recap]"), null, "no spoilers: no score, no goals");
  hidden.window.close();
  const noOdds = makeApp('<div id="v26Root"><div id="v26Head"></div></div>', { payload: { ...PAYLOAD, offers: [] } });
  await tick(120);
  assert.ok(noOdds.document.querySelector("[data-v32-recap]"));
  assert.equal(noOdds.document.querySelector("[data-v32-bet]"), null, "no fresh live prices: no empty bet card");
  assert.ok(!noOdds.document.getElementById("v26Root").classList.contains("v32Live"), "and the line before the start stays");
  noOdds.window.close();
}
{
  // the home page: the live match of the day goes first with its live line; a game not on stays where it is
  const hero = (live) => `<section class="v27Home"><div class="v27Sec" data-sec="days" style="order:0"></div><div class="v27Sec" data-sec="hero" style="order:4"><article class="v27Hero" data-game="2026020107"><div class="v27HeroBody"><div class="v27HeroTeams">${live ? '<span class="v27LiveBadge">LIVE</span>' : ""}</div><div class="v29Slot" data-v29-game="2026020107"></div><div class="v27Wl"></div></div></article></div></section>`;
  const on = makeApp(hero(true));
  await tick(150);
  const home = on.document.querySelector(".v27Home");
  assert.ok(home.classList.contains("v32LiveFirst"), "the live match of the day first");
  assert.match(on.document.getElementById("v32css").textContent, /\.v27Home\.v32LiveFirst>\[data-sec="hero"\]\{order:-1!important\}/);
  assert.match(on.document.getElementById("v32css").textContent, /content:"Сейчас в эфире"/);
  const hb = on.document.querySelector("[data-v32-hero-bet]");
  assert.equal(hb.previousElementSibling.className, "v29Slot", "under the vote");
  assert.deepEqual([...hb.querySelectorAll(".v32Chip")].map(text), ["Следующий гол — DAL 2.37", "Тотал больше 5,5 3.40"], "the next goal and the total first");
  on.window.close();
  const off = makeApp(hero(false));
  await tick(150);
  assert.ok(!off.document.querySelector(".v27Home").classList.contains("v32LiveFirst"));
  assert.equal(off.document.querySelector("[data-v32-hero-bet]"), null);
  off.window.close();
}

console.log("live v32 validation passed");
