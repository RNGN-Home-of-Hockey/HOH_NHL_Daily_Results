// Live Center home page (v27): the mood of the page (live / results / schedule), the score strip, the goals shelf, the match of the day,
// three news with the news page, the videos, no-spoilers mode and the fallback to the old home.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import {
  nhlDateOf, gameFromRow, pickHome, stripOf, periodShort, playedTime, goalMoment, buildGoalTiles, applyNames, applyHeroLive, buildHomePayload,
  GOALS_WINDOW_MS, MAX_TILES, MIN_TILES,
} from "../cloudflare-worker/src/telegram-center-v27-home-data.js";
import { handleTelegramCenterV27, loadHomePayload } from "../cloudflare-worker/src/telegram-center-v27-home.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";
import { handleTelegramCenterV19ProductData } from "../cloudflare-worker/src/telegram-center-v19-product-data.js";
import { handleTelegramCenterV20Ui } from "../cloudflare-worker/src/telegram-center-v20-ui.js";
import { handleTelegramCenterV16Hotfix } from "../cloudflare-worker/src/telegram-center-v16-hotfix.js";
import { handleTelegramCenterV15CoreUi } from "../cloudflare-worker/src/telegram-center-v15-core-ui.js";

const HOUR = 3600 * 1000;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plain = (v) => JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ---- fixtures -------------------------------------------------------------------------------------------------------------------
const NOW = Date.parse("2026-10-13T06:00:00Z");
let pkSeq = 2026020000;
function game(startOffsetH, state, { away = "FLA", home = "BUF", a = null, h = null, type = 2, pk = ++pkSeq, finish = "REG", base = NOW } = {}) {
  const start = base + startOffsetH * HOUR;
  return gameFromRow({
    calendar_date: nhlDateOf(start), game_pk: pk, game_type: type, scheduled_start_utc: iso(start), game_state: state, away_tri: away, home_tri: home,
    away_score: a, home_score: h, period_type: finish, away_name_ru: `${away} RU`, home_name_ru: `${home} RU`,
  });
}
const goal = (event, period, remaining, away, home, scorerId, scorer, team, extra = {}) => ({
  event_id: event, period, time_remaining: remaining, away_score: away, home_score: home, scorer, scorer_id: scorerId, team, duration: 44,
  orig: { path: `orig/${event}.mp4`, bytes: 10 }, light: { path: `tg/${event}.mp4`, bytes: 5 }, poster: `_thumbs/${event}.jpg`, ...extra,
});
const BASE = "https://clips.test";

// ---- 1) the day: which mood, which day ------------------------------------------------------------------------------------------
{
  assert.equal(nhlDateOf(Date.parse("2026-10-13T07:59:00Z")), "2026-10-12", "the NHL day ends at 08:00 UTC (the Matches tab counts it the same way)");
  assert.equal(nhlDateOf(Date.parse("2026-10-13T08:00:00Z")), "2026-10-13");

  // some game is on: the page follows it
  let games = [game(-1, "LIVE", { a: 1, h: 0 }), game(-6, "OFF", { a: 3, h: 2 }), game(3, "FUT")];
  let pick = pickHome(games, NOW);
  assert.equal(pick.mode, "live");
  assert.equal(pick.stripDay, games[0].date);
  assert.equal(pick.heroDay, games[0].date);

  // the night is over: results of the day that just ended, the match of the day is the first game of the next day with games
  games = [game(-5, "OFF", { a: 3, h: 2 }), game(-8, "OFF", { a: 1, h: 0 }), game(20, "FUT")];
  pick = pickHome(games, NOW);
  assert.equal(pick.mode, "results");
  assert.equal(pick.stripDay, games[0].date, "the strip shows the finished day");
  assert.equal(pick.heroDay, games[2].date, "the match of the day looks ahead");
  assert.notEqual(pick.stripDay, pick.heroDay);

  // the next game is close: it is time for the schedule, not for the results
  games = [game(-5, "OFF", { a: 3, h: 2 }), game(2, "FUT")];
  pick = pickHome(games, NOW);
  assert.equal(pick.mode, "schedule");
  assert.equal(pick.stripDay, games[1].date);
  assert.equal(pick.heroDay, games[1].date);

  // the last game finished long ago: the schedule of the next day
  games = [game(-20, "OFF", { a: 3, h: 2 }), game(18, "FUT")];
  pick = pickHome(games, NOW);
  assert.equal(pick.mode, "schedule");
  assert.equal(pick.stripDay, games[1].date);

  // nothing ahead at all (the end of the season): the last results, never an empty page
  games = [game(-20, "OFF", { a: 3, h: 2 })];
  pick = pickHome(games, NOW);
  assert.equal(pick.mode, "results");
  assert.equal(pick.stripDay, games[0].date);
  assert.equal(pick.heroDay, games[0].date);

  // a game whose start passed hours ago but is still "FUT" in the database is not "ahead"
  games = [game(-7, "FUT"), game(-4, "OFF", { a: 1, h: 0 })];
  assert.equal(pickHome(games, NOW).mode, "results", "a stale FUT row does not hold the page in schedule mode");
  // postponed games are ignored
  games = [game(2, "PPD"), game(-4, "OFF", { a: 1, h: 0 })];
  assert.equal(pickHome(games, NOW).mode, "results");

  assert.deepEqual(pickHome([], NOW), { mode: "idle", today: nhlDateOf(NOW), stripDay: null, heroDay: null });
  assert.equal(buildHomePayload({ games: [], now: NOW }).games.length, 0);

  // the strip: on now, then ahead (soonest first), then finished
  const day = [game(-20, "OFF", { a: 1, h: 0, pk: 1 }), game(9, "FUT", { pk: 2 }), game(1, "FUT", { pk: 3 }), game(0, "LIVE", { pk: 4, a: 0, h: 0 }), game(-19, "OFF", { a: 2, h: 1, pk: 5 })];
  const sameDay = day.map((g) => ({ ...g, date: "2026-10-12" }));
  assert.deepEqual(stripOf(sameDay, "2026-10-12").map((g) => g.game_pk), [4, 3, 2, 1, 5]);
  assert.equal(stripOf(sameDay, "2026-10-13").length, 0);
}

// ---- 2) goal clips --------------------------------------------------------------------------------------------------------------
{
  assert.equal(periodShort(1, 2), "1-й");
  assert.equal(periodShort(3, 2), "3-й");
  assert.equal(periodShort(4, 2), "ОТ");
  assert.equal(periodShort(4, 3), "ОТ");
  assert.equal(periodShort(5, 3), "2ОТ", "second overtime of the playoffs");
  assert.equal(playedTime(1, "14:02", 2), "05:58", "the index keeps the time left, the app shows the time played");
  assert.equal(playedTime(3, "00:00", 2), "20:00");
  assert.equal(playedTime(4, "01:30", 2), "03:30", "regular-season overtime is 5 minutes");
  assert.equal(playedTime(4, "17:00", 3), "03:00", "playoff overtime is 20 minutes");
  assert.equal(playedTime(2, "bad", 2), null);

  // two games started together: a goal late in the 1st period of one comes after an early one of the other
  const a = game(-4, "OFF", { pk: 11 });
  const b = game(-4, "OFF", { pk: 12 });
  assert.ok(goalMoment(a, goal(1, 1, "10:00")) < goalMoment(b, goal(2, 1, "02:00")));
  assert.ok(goalMoment(a, goal(1, 2, "19:00")) > goalMoment(a, goal(2, 1, "00:30")), "the 2nd period comes after the 1st");

  const finalToday = game(-10, "OFF", { pk: 21, away: "VGK", home: "MIN", a: 2, h: 3 });
  const finalYesterday = game(-34, "OFF", { pk: 22, away: "OTT", home: "NJD", a: 4, h: 1 });
  const tooOld = game(-45, "OFF", { pk: 23, away: "SEA", home: "PHI", a: 1, h: 0 });
  const upcoming = game(5, "FUT", { pk: 24, away: "COL", home: "DAL" });
  const index = {
    games: [
      { game_pk: 21, goals: [goal(101, 1, "14:02", 0, 1, 1, "Josh Doan", "MIN"), goal(102, 2, "09:00", 1, 1, 2, "Mark Stone", "VGK"), { event_id: 103, period: 3, time_remaining: "01:00", away_score: 2, home_score: 3, scorer: "No Clip", scorer_id: 3, team: "MIN" }] },
      { game_pk: 22, goals: [goal(201, 1, "05:00", 1, 0, 4, "Tim Stützle", "OTT"), goal(202, 3, "03:00", 4, 1, 5, "Brady Tkachuk", "OTT", { light: undefined })] },
      { game_pk: 23, goals: [goal(301, 1, "10:00", 1, 0, 6, "Old Goal", "SEA")] },
      { game_pk: 24, goals: [goal(401, 1, "10:00", 1, 0, 7, "Future Goal", "COL")] },
    ],
  };
  const games = [finalToday, finalYesterday, tooOld, upcoming];
  const shelf = buildGoalTiles({ games, index, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(shelf.ok, true);
  assert.equal(shelf.day, finalToday.date, "the newest day with clips leads");
  assert.equal(shelf.live, false);
  const ids = shelf.items.map((t) => t.event_id);
  assert.deepEqual(ids, [102, 101, 202, 201], "newest first; the fill from the day before; a goal without a clip, a game outside the window and an upcoming game are left out");
  assert.equal(shelf.total, 4);
  assert.ok(shelf.items.every((t) => !("moment" in t)), "the internal sorting key is not published");
  const t101 = shelf.items.find((t) => t.event_id === 101);
  assert.equal(t101.clip_url, `${BASE}/tg/101.mp4`, "the light copy for the app");
  assert.equal(t101.poster_url, `${BASE}/_thumbs/101.jpg`);
  assert.equal(t101.time, "05:58");
  assert.equal(t101.period_short, "1-й");
  assert.equal(t101.team, "MIN");
  assert.equal(t101.away.tri, "VGK");
  assert.equal(t101.home.tri, "MIN");
  assert.equal(t101.scorer_en, "Josh Doan");
  assert.equal(t101.home_score, 1);
  assert.equal(shelf.items.find((t) => t.event_id === 202).clip_url, `${BASE}/orig/202.mp4`, "no light copy yet: the original is the only file");

  // enough goals on the newest day: the day before does not come in
  const many = { games: [{ game_pk: 21, goals: Array.from({ length: 20 }, (_, i) => goal(500 + i, 1 + Math.floor(i / 7), "10:00", 0, i, 1, "Many", "MIN")) }, { game_pk: 22, goals: [goal(900, 1, "10:00", 0, 1, 2, "Older", "OTT")] }] };
  const capped = buildGoalTiles({ games: [finalToday, finalYesterday], index: many, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(capped.items.length, MAX_TILES);
  assert.equal(capped.total, 20, "the count says how many clips the day has, the shelf shows the newest ones");
  assert.ok(!capped.items.some((t) => t.event_id === 900));
  assert.ok(capped.total >= MIN_TILES);

  // a game that is on: the shelf is "live" and carries its goals
  const live = game(-1, "LIVE", { pk: 31, away: "NYR", home: "TBL", a: 1, h: 0 });
  const liveShelf = buildGoalTiles({ games: [live], index: { games: [{ game_pk: 31, goals: [goal(601, 1, "12:00", 1, 0, 8, "Artemi Panarin", "NYR")] }] }, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(liveShelf.live, true);
  assert.equal(liveShelf.items.length, 1);

  // the clip server is down: no shelf, no failure
  assert.deepEqual(buildGoalTiles({ games, index: null, indexOk: false, now: NOW }), { ok: false, day: null, live: false, total: 0, items: [] });
  assert.equal(buildGoalTiles({ games: [upcoming], index, indexOk: true, now: NOW }).items.length, 0);
  assert.equal(GOALS_WINDOW_MS, 40 * HOUR);

  // Russian names come from the database, the English one stays as the fallback
  applyNames(shelf, new Map([[1, "Джош Доан"]]));
  assert.equal(shelf.items.find((t) => t.scorer_id === 1).scorer_ru, "Джош Доан");
  assert.equal(shelf.items.find((t) => t.scorer_id === 2).scorer_ru, null);

  // the match of the day takes the exact score and the label from the live feed
  const payload = { games: [{ game_pk: 5, away_score: 0, home_score: 0, state: "LIVE" }, { game_pk: 6, away_score: 9, home_score: 9, state: "LIVE" }], featured: { game_pk: 5, game_state: "LIVE", away_score: 0, home_score: 0 } };
  applyHeroLive(payload, { code: "CRIT", label: "3-й период · 02:10", away_score: 2, home_score: 3 });
  assert.equal(payload.featured.live_label, "3-й период · 02:10");
  assert.equal(payload.featured.away_score, 2);
  assert.equal(payload.games[0].home_score, 3, "the strip shows the same score as the card");
  assert.equal(payload.games[1].home_score, 9, "other games are untouched");
  assert.equal(applyHeroLive({ games: [], featured: null }, { code: "LIVE" }).featured, null);
}

// ---- 3) the route ---------------------------------------------------------------------------------------------------------------
{
  const calls = [];
  const deps = {
    loadGames: async () => [game(-5, "OFF", { pk: 41, away: "VGK", home: "MIN", a: 2, h: 3 }), game(20, "FUT", { pk: 42, away: "SEA", home: "PHI" })],
    loadFeatured: async (_env, day) => { calls.push(["featured", day]); return { game_pk: 42, game_state: "FUT", away: { tri: "SEA" }, home: { tri: "PHI" } }; },
    loadIndex: async (base) => { calls.push(["index", base]); return { games: [{ game_pk: 41, goals: [goal(701, 1, "10:00", 0, 1, 9, "Joel Eriksson Ek", "MIN")] }] }; },
    loadNames: async (_env, ids) => { calls.push(["names", ids]); return new Map([[9, "Юэль Эрикссон Эк"]]); },
    loadHeroLive: async () => { throw new Error("not live"); },
  };
  const payload = await loadHomePayload({ HOH_CLIPS_BASE: "https://other.test/" }, { now: NOW, deps });
  assert.equal(payload.ok, true);
  assert.equal(payload.version, "27.0");
  assert.equal(payload.mode, "results");
  assert.equal(payload.games.length, 1);
  assert.equal(payload.games[0].game_pk, 41);
  assert.equal(payload.featured.game_pk, 42);
  assert.deepEqual(calls.find((c) => c[0] === "featured"), ["featured", payload.hero_day], "the match of the day is asked for the day it looks at");
  assert.deepEqual(calls.find((c) => c[0] === "index"), ["index", "https://other.test"], "the clip server base can be changed in the settings");
  assert.deepEqual(calls.find((c) => c[0] === "names"), ["names", [9]]);
  assert.equal(payload.goals.items[0].scorer_ru, "Юэль Эрикссон Эк");
  assert.equal(payload.goals.items[0].clip_url, "https://other.test/tg/701.mp4");

  // every helper may fail: the page still answers with what it has
  const broken = await loadHomePayload({}, { now: NOW, deps: { ...deps, loadFeatured: async () => { throw new Error("db"); }, loadIndex: async () => { throw new Error("offline"); }, loadNames: async () => { throw new Error("db"); } } });
  assert.equal(broken.ok, true);
  assert.equal(broken.featured, null);
  assert.equal(broken.goals.ok, false);
  assert.equal(broken.games.length, 1);

  // a live match of the day: the label comes from the NHL feed
  const liveDeps = { ...deps, loadGames: async () => [game(-1, "LIVE", { pk: 43, a: 1, h: 0 })], loadFeatured: async () => ({ game_pk: 43, game_state: "LIVE", away_score: 0, home_score: 0 }), loadHeroLive: async () => ({ code: "LIVE", label: "2-й период · 14:32", away_score: 1, home_score: 1 }) };
  const liveOne = await loadHomePayload({}, { now: NOW, deps: liveDeps });
  assert.equal(liveOne.mode, "live");
  assert.equal(liveOne.featured.live_label, "2-й период · 14:32");
  assert.equal(liveOne.games[0].home_score, 1);

  // HTTP: only GET, no database means a clear error, the script is served
  const noDb = await handleTelegramCenterV27(new Request("https://x.test/api/telegram-center-v27/home"), {}, "/api/telegram-center-v27/home");
  assert.equal(noDb.status, 503);
  assert.equal((await noDb.json()).error, "missing_d1_binding");
  const post = await handleTelegramCenterV27(new Request("https://x.test/api/telegram-center-v27/home", { method: "POST" }), {}, "/api/telegram-center-v27/home");
  assert.equal(post.status, 405);
  assert.equal(await handleTelegramCenterV27(new Request("https://x.test/other"), {}, "/other"), null);
  const script = await handleTelegramCenterV27(new Request("https://x.test/telegram-app/v27-home.js"), {}, "/telegram-app/v27-home.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  const source = await script.text();
  assert.match(source, /^\(function\(\)\{const __name=/);
  new Function(source);
  assert.equal((await handleTelegramCenterV27(new Request("https://x.test/telegram-app/v27-home.js", { method: "POST" }), {}, "/telegram-app/v27-home.js")).status, 405);

  // the whole chain with a fake database: the SQL answers, the shared edge cache is used
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  const row = (pk, startOffsetH, state, extra = {}) => {
    const start = Date.now() + startOffsetH * HOUR;
    return {
      calendar_date: nhlDateOf(start), game_pk: pk, season_id: "20262027", game_type: 2, scheduled_start_utc: iso(start), game_state: state, home_tri: "BOS", away_tri: "PHI",
      home_score: 2, away_score: 1, period_type: "REG", venue_name: "TD Garden", home_name_en: "Boston", home_name_ru: "Бостон", away_name_en: "Philadelphia", away_name_ru: "Филадельфия",
      home_logo: null, away_logo: null, source_key: null, vk_title: null, vk_url: null, vk_app_url: null, vk_thumbnail: null, vk_status: null,
      winline_event_id: null, winline_p1: null, winline_x: null, winline_p2: null, ...extra,
    };
  };
  let prepared = 0;
  const sqls = [];
  const db = (rows) => ({ prepare: (sql) => { prepared += 1; sqls.push(sql); return { bind: () => ({ all: async () => ({ results: rows }), first: async () => null }), all: async () => ({ results: [] }) }; } });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/index.json")) return new Response(JSON.stringify({ version: 1, games: [] }), { status: 200 });
    if (u.endsWith("/covers.json")) return new Response(JSON.stringify({ version: 1, covers: {} }), { status: 200 });
    return new Response("no", { status: 404 });
  };
  const store = new Map();
  globalThis.caches = { default: { match: async (req) => store.get(req.url)?.clone(), put: async (req, res) => { store.set(req.url, res); } } };
  const env = { DB: db([row(7001, -5, "OFF"), row(7002, 20, "FUT")]) };
  const first = await handleTelegramCenterV27(new Request("https://x.test/api/telegram-center-v27/home"), env, "/api/telegram-center-v27/home");
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control"), /max-age=10/);
  const body = await first.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "results");
  assert.ok(body.games.length >= 1);
  assert.equal(body.featured.game_pk, 7002, "the match of the day is a game that has not finished yet (the home page asks the featured endpoint with focus=now)");
  assert.ok(sqls.some((s) => /FROM games g/.test(s) && /scheduled_start_utc>=\?/.test(s)), "the games of the window are read in one query");
  const afterFirst = prepared;
  const second = await handleTelegramCenterV27(new Request("https://x.test/api/telegram-center-v27/home"), env, "/api/telegram-center-v27/home");
  assert.deepEqual(await second.json(), body);
  assert.equal(prepared, afterFirst, "the second visitor within seconds reads nothing from the database");
  globalThis.caches = realCaches;
  globalThis.fetch = realFetch;

  // the match of the day with focus=now: a game on beats the rest, a game not finished beats the finished ones
  const featRows = (list) => ({ HOH_CLIPS_BASE: BASE, DB: db(list) });
  const ask = async (list, query) => (await (await handleTelegramCenterV19ProductData(new Request(`https://x.test/api/telegram-center-v19/featured?date=2026-10-12${query}`), featRows(list), "/api/telegram-center-v19/featured")).json()).featured;
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, covers: {} }), { status: 200 });
  const strongFinal = row(8001, -10, "OFF", { game_type: 3 });
  const weakLive = row(8002, -1, "LIVE", { home_tri: "CHI", away_tri: "ANA" });
  const weakSoon = row(8003, 2, "FUT", { home_tri: "SJS", away_tri: "NSH" });
  assert.equal((await ask([strongFinal, weakLive, weakSoon], "")).game_pk, 8001, "without the parameter the strongest game wins, as before");
  assert.equal((await ask([strongFinal, weakLive, weakSoon], "&focus=now")).game_pk, 8002, "a game that is on");
  assert.equal((await ask([strongFinal, weakSoon], "&focus=now")).game_pk, 8003, "not finished beats finished");
  assert.equal((await ask([strongFinal], "&focus=now")).game_pk, 8001, "only finished games: the strongest of them");
  globalThis.fetch = realFetch;
}

// ---- 4) the shell and the old layers -------------------------------------------------------------------------------------------
const v20 = await (await handleTelegramCenterV20Ui(new Request("https://x.test/telegram-app/v20.js"), "/telegram-app/v20.js")).text();
const v16 = await (await handleTelegramCenterV16Hotfix(new Request("https://x.test/telegram-app/v16.js"), "/telegram-app/v16.js")).text();
const v15core = await (await handleTelegramCenterV15CoreUi(new Request("https://x.test/telegram-app/v15-core.js"), "/telegram-app/v15-core.js")).text();
const v27 = await (await handleTelegramCenterV27(new Request("https://x.test/telegram-app/v27-home.js"), {}, "/telegram-app/v27-home.js")).text();
{
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v27-home.js"), "the home page script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v27-home.js") > shell.indexOf("/telegram-app/v26-goals.js"), "it loads after the match screen");
  assert.ok(shell.indexOf("/telegram-app/v27-home.js") > shell.indexOf("/telegram-app/v22.js"), "and after the layers it takes the home from");
  const routed = await handleTeamCurrentRequest(new Request("https://x.test/telegram-app/v27-home.js"), {}, "/telegram-app/v27-home.js");
  assert.equal(routed.status, 200, "the script is reachable through the main router");
  const api = await handleTeamCurrentRequest(new Request("https://x.test/api/telegram-center-v27/home"), {}, "/api/telegram-center-v27/home");
  assert.equal(api.status, 503, "the home route is wired into the main router (no database here)");

  // the news queries hand the link to the source to the page
  const newsSource = fs.readFileSync(new URL("../cloudflare-worker/src/telegram-center-v20-news.js", import.meta.url), "utf8");
  assert.equal((newsSource.match(/n\.source_badge,n\.source_url,n\.published_at/g) || []).length, 3, "home, player and single-news queries carry source_url");

  // the old layers stay quiet while the new home owns the tab
  assert.match(v20, /async function mountFeaturedGame\(force=false\)\{if\(window\.HOHV27\?\.owns\?\.\(\)\)return;/);
  assert.match(v20, /async function mountHomeNews\(force=false\)\{\s*if\(window\.HOHV27\?\.owns\?\.\(\)\)return;/);
  assert.match(v16, /async function stableHome\(\)\{if\(window\.HOHV27\?\.owns\?\.\(\)\)return;/);
  assert.match(v15core, /async function home\(force=false\)\{purgeMediaOffHome\(\);if\(!homeMediaAllowed\(\)\|\|window\.HOHV27\?\.owns\?\.\(\)\)return;/);

  const dom = new JSDOM('<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button></nav><main id="view"><div class="dateBox">2026-10-13</div><div class="toolbar"></div></main></body>', { url: "https://x.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const calls = [];
  window.HOHV15 = { esc, state: { profile: false }, currentTab: () => "games", tabsVisible: () => true, view: () => window.document.getElementById("view"), V2: "/v2", api: async (url) => { calls.push(url); return { ok: true, items: [], news: [], featured: null }; } };
  window.HOHV27 = { owns: () => true };
  window.eval(v20);
  await tick(350);
  assert.equal(calls.length, 0, "the old home asks for nothing while the new one owns the tab");
  window.close();
}

// ---- 5) the page in the browser -------------------------------------------------------------------------------------------------
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const logo = (tri) => `https://l.test/${tri}.svg`;
const chip = (pk, away, home, phase, a, h, startOffsetH = 2, finish = null) => ({
  game_pk: pk, date: localDay(), start: iso(Date.now() + startOffsetH * HOUR), state: phase === "live" ? "LIVE" : phase === "final" ? "OFF" : "FUT", phase, is_playoff: false,
  away: { tri: away, name_ru: `${away} ру`, logo: logo(away) }, home: { tri: home, name_ru: `${home} ру`, logo: logo(home) }, away_score: a, home_score: h, finish,
});
const tile = (event, pk, name, nameRu, team, period, time, a, h, extra = {}) => ({
  game_pk: pk, event_id: event, date: localDay(), live: false, team, scorer_id: event, scorer_ru: nameRu, scorer_en: name, period, period_short: `${period}-й`, time,
  away: { tri: "VGK", logo: logo("VGK") }, home: { tri: "MIN", logo: logo("MIN") }, away_score: a, home_score: h, clip_url: `https://clips.test/tg/${event}.mp4`, poster_url: `https://clips.test/p/${event}.jpg`, duration: 44, ...extra,
});
const NEWS = [
  { news_id: 301, title: "Первая новость про Овечкина и его гол в овертайме против Рейнджерс в Нью-Йорке", body_text: "Полный текст первой новости.", source_badge: null, published_at: iso(Date.now() - 10 * 60000), comment_count: 5 },
  { news_id: 302, title: "Вторая новость", body_text: "", source_url: "https://www.sports.ru/hockey/1234567-test.html", source_badge: "Sports.ru", published_at: iso(Date.now() - 5 * HOUR), comment_count: 0 },
  { news_id: 303, title: "Третья новость", body_text: null, source_url: "javascript:alert(1)", source_badge: null, published_at: iso(Date.now() - 30 * HOUR), comment_count: 0 },
  { news_id: 304, title: "Четвёртая новость", body_text: "Текст четвёртой новости, достаточно длинный, чтобы показать превью.", source_badge: null, published_at: iso(Date.now() - 50 * HOUR), comment_count: 1 },
  { news_id: 305, title: "Пятая новость", body_text: "", source_badge: null, published_at: iso(Date.now() - 80 * HOUR), comment_count: 0 },
];
const MEDIA = [
  { kind: "short", title: "Овечкин забил #shorts", url: "https://youtu.be/a", thumb: "https://i.test/a.jpg" },
  { kind: "news", title: "NHL News: Daily update", url: "https://youtu.be/n", thumb: "https://i.test/n.jpg" },
  { kind: "short", title: "Гол недели Home of Hockey", url: "https://youtu.be/b", thumb: "https://i.test/b.jpg" },
  { kind: "short", title: "Третье короткое", url: "https://youtu.be/c", thumb: "https://i.test/c.jpg" },
  { kind: "short", title: "Четвёртое короткое", url: "https://youtu.be/d", thumb: "https://i.test/d.jpg" },
];
const featured = (extra = {}) => ({
  game_pk: 2026020094, game_type: 2, game_state: "FUT", scheduled_start_utc: iso(Date.now() + 20 * HOUR), away_score: 0, home_score: 0,
  away: { tri: "SEA", name_ru: "Сиэтл Кракен", logo: logo("SEA") }, home: { tri: "PHI", name_ru: "Филадельфия Флайерз", logo: logo("PHI") },
  vk_url: "https://vkvideo.ru/video-1_2", thumbnail_url: null, cover_url: null, winline: { event_id: 1, p1: 2.35, x: 4.2, p2: 2.55 }, ...extra,
});
const homeData = (extra = {}) => ({
  ok: true, version: "27.0", mode: "results", today: localDay(), strip_day: localDay(), hero_day: localDay(),
  games: [chip(1, "FLA", "BUF", "final", 3, 5, -10), chip(2, "OTT", "NJD", "final", 4, 1, -9, "OT"), chip(3, "VGK", "MIN", "final", 2, 4, -8)],
  featured: featured(),
  goals: { ok: true, day: localDay(), live: false, total: 20, items: [tile(11, 3, "Joel Eriksson Ek", "Юэль Эрикссон Эк", "MIN", 3, "18:38", 2, 4), tile(12, 3, "William Karlsson", "", "VGK", 3, "09:25", 2, 3), tile(13, 3, "Rasmus Andersson", "Расмус Андерссон", "VGK", 2, "02:37", 1, 3)] },
  ...extra,
});

function makeHome({ data = homeData(), news = NEWS, media = MEDIA, comments = {}, failHome = false, spoilers = false, tabName = "games" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button><button class="tab" data-tab="broadcasts"></button><button class="tab" data-tab="teams"></button></nav>
     <main id="view" class="view"><div class="dateBox">2026-10-13</div><div class="toolbar"></div><div id="gameList"><article class="gameCard" data-game="1"></article></div></main></body>`,
    { url: "https://example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;
  const { document } = window;
  const timers = [];
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, ms, ...rest); };
  const box = { data, news: news.map((n) => ({ ...n })), media, comments, failHome, spoilers };
  const calls = [];
  const opened = [];
  const posted = [];
  const view = () => document.getElementById("view");
  const H = (window.HOHV15 = {
    esc, state: { profile: false }, runs: 0, view,
    currentTab: () => document.querySelector(".tab.active")?.dataset.tab || "",
    tabsVisible: () => document.getElementById("tabs").style.display !== "none",
    backRow: (kind) => `<div class="v15BackRow"><button class="v15Back" id="v15Back">‹</button><div class="v15Kind">${esc(kind)}</div></div>`,
    openGameV19: (pk, ctx) => opened.push({ pk, ctx }),
    runCore() { H.runs += 1; },
    api: async (url, opt) => {
      calls.push({ url, opt });
      if (url.startsWith("/api/telegram-center-v27/home")) { if (box.failHome) throw new Error("HTTP 500"); return box.data; }
      if (url.startsWith("/api/telegram-center-v20/news/home")) return { ok: true, news: box.news };
      if (url.startsWith("/api/telegram-center-v12/media")) return { ok: true, items: box.media };
      let m = /\/news\/(\d+)\/comments/.exec(url);
      if (m && opt?.method === "POST") { const body = JSON.parse(opt.body).body; posted.push({ id: Number(m[1]), body }); (box.comments[m[1]] = box.comments[m[1]] || []).push({ author: "Я", body, created_at: new Date().toISOString() }); return { ok: true }; }
      if (m) return { ok: true, comments: box.comments[m[1]] || [] };
      m = /\/news\/(\d+)$/.exec(url);
      if (m) return { ok: true, news: box.news.find((n) => n.news_id === Number(m[1])) || null };
      return { ok: true };
    },
  });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    H.state.profile = false;
    view().innerHTML = t.dataset.tab === "games" ? '<div class="toolbar"></div><div id="gameList"></div>' : '<div id="other">tab</div>';
  }));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  window.HOHNoSpoilers = () => box.spoilers;
  window.HOHEnsureCommentIdentity = async () => true;
  window.alert = () => {};
  window.scrolls = [];
  window.scrollTo = (x, y) => { window.scrolls.push([x, y]); };
  window.HTMLMediaElement.prototype.play = function play() { this.dispatchEvent(new window.Event("play")); return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  window.HTMLMediaElement.prototype.load = function load() {};
  window.eval(v27);
  return { window, document, H, box, calls, opened, posted, timers, S: window.HOHV27 };
}
const sec = (ctx, name) => ctx.document.querySelector(`.v27Home [data-sec="${name}"]`);

{
  // the first screen: strip, goals, match of the day, three news, videos — in the order of the "results" mood
  const ctx = makeHome();
  await tick(420);
  const home = ctx.document.querySelector("#view > .v27Home");
  assert.ok(home, "the new home is the first thing on the page");
  assert.equal(home, ctx.document.getElementById("view").firstElementChild);
  assert.ok(ctx.window.HOHV27.owns());
  const css = ctx.document.getElementById("v27css").textContent;
  assert.match(css, /\.v27Home~\*\{display:none!important\}/, "whatever the old layers left after the new home is hidden");

  const chips = [...sec(ctx, "strip").querySelectorAll(".v27Chip")];
  assert.equal(chips.length, 3);
  assert.match(text(sec(ctx, "strip").querySelector(".v27Head b")), /^Итоги · /, "the night is over: results, not schedule");
  assert.equal(text(chips[0]), "Финал3 : 5FLA · BUF");
  assert.equal(text(chips[1]), "Финал · ОТ4 : 1OTT · NJD");
  assert.ok(chips[0].querySelectorAll("img").length === 2, "both logos");
  assert.equal(sec(ctx, "strip").querySelectorAll("[data-v27-all]").length, 2, "'Все матчи' in the header and at the end of the strip");

  assert.equal(sec(ctx, "goals").style.order, "2", "results: the goals come before the match of the day");
  assert.equal(sec(ctx, "hero").style.order, "3");
  assert.match(text(sec(ctx, "goals").querySelector(".v27Head")), /Голы вчера|Голы сегодня/);
  assert.match(text(sec(ctx, "goals").querySelector(".v27Head")), /20 роликов/);
  const tiles = [...sec(ctx, "goals").querySelectorAll(".v27Goal")];
  assert.equal(tiles.length, 3);
  assert.match(text(tiles[0]), /Эрикссон Эк/, "the surname in Russian");
  assert.match(text(tiles[0]), /VGK 2:4 MIN/);
  assert.match(text(tiles[0]), /3-й · 18:38/);
  assert.match(text(tiles[0]), /0:44/);
  assert.match(text(tiles[1]), /Karlsson/, "no Russian name: the English surname");
  assert.equal(tiles[0].querySelector("img.cover").getAttribute("src"), "https://clips.test/p/11.jpg");

  const hero = sec(ctx, "hero");
  assert.match(text(hero), /Матч дня/);
  assert.match(text(hero), /Сиэтл Кракен/);
  assert.match(text(hero), /Филадельфия Флайерз/);
  assert.ok(hero.querySelector(".v27Wl img[alt=WINLINE]"));
  assert.deepEqual([...hero.querySelectorAll(".v27Odd")].map((a) => text(a)), ["П12.35", "Н4.20", "П22.55"]);
  assert.match(hero.querySelector(".v27Odd").getAttribute("href"), /^\/go\/winline\?game_pk=2026020094$/);
  assert.match(text(hero.querySelector(".v27Cta")), /Трансляция в VK Видео/);
  assert.equal(hero.querySelector(".v27Cta").getAttribute("href"), "https://vkvideo.ru/video-1_2");
  assert.ok(!hero.querySelector(".v27LiveBadge"));

  const news = [...sec(ctx, "news").querySelectorAll(".v27News")];
  assert.equal(news.length, 3, "three news on the home page");
  assert.match(text(sec(ctx, "news").querySelector(".v27Head")), /Свежее в НХЛ/);
  assert.match(css, /\.v27NTitle\{[^}]*-webkit-line-clamp:2/, "two-line headlines");
  assert.match(text(news[0]), /10 мин назад/);
  assert.ok(news[0].querySelector(".cm"), "a news with comments shows the counter");
  assert.equal(text(news[0].querySelector(".cm")), "5");
  assert.ok(!news[1].querySelector(".cm"), "no counter for zero comments");
  assert.match(text(news[1]), /Sports\.ru/);
  assert.match(text(news[1]), /5 ч назад/);

  const videos = [...sec(ctx, "videos").querySelectorAll(".v27Video")];
  assert.equal(videos.length, 3);
  assert.match(text(videos[0]), /ВЫПУСК/, "the newest release first");
  assert.equal(text(videos[0].querySelector(".t")), "Свежий выпуск новостей НХЛ", "an English title becomes a Russian caption");
  assert.equal(text(videos[1].querySelector(".t")), "Овечкин забил", "hashtags are cut");
  assert.equal(videos[0].getAttribute("href"), "https://youtu.be/n");

  // the old blocks are gone from the page
  assert.ok(!ctx.document.querySelector(".v15Media, .v20News, .v25FeaturedGame"));
  ctx.window.close();
}

{
  // the mood changes the order: live and schedule put the match of the day first
  for (const mode of ["live", "schedule"]) {
    const ctx = makeHome({ data: homeData({ mode }) });
    await tick(420);
    assert.equal(sec(ctx, "hero").style.order, "2", `${mode}: the match of the day leads`);
    assert.equal(sec(ctx, "goals").style.order, "3");
    ctx.window.close();
  }
  // live: the strip says today's games, a red LIVE chip, "Голы в эфире", and the page polls every 15 seconds
  const data = homeData({
    mode: "live",
    games: [chip(1, "NYR", "TBL", "live", 1, 0, -1), chip(2, "COL", "DAL", "upcoming", null, null, 3), chip(3, "FLA", "BUF", "final", 3, 5, -6)],
    featured: featured({ game_state: "LIVE", away_score: 1, home_score: 0, live_label: "2-й период · 14:32", thumbnail_url: null, scheduled_start_utc: iso(Date.now() - HOUR) }),
  });
  data.goals.live = true;
  const ctx = makeHome({ data });
  await tick(420);
  const chips = [...sec(ctx, "strip").querySelectorAll(".v27Chip")];
  assert.ok(chips[0].classList.contains("live"));
  assert.ok(chips[0].querySelector(".v27Live"), "LIVE on the chip");
  assert.match(text(chips[0]), /LIVE1 : 0/);
  assert.match(text(chips[1]), /COL · DAL/);
  assert.ok(chips[1].classList.contains("up"));
  assert.equal(text(chips[1].querySelector(".v27ChipMid")), "—");
  assert.equal(text(chips[1].querySelector(".v27ChipTop")), new Date(data.games[1].start).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
  assert.match(text(sec(ctx, "strip").querySelector(".v27Head b")), /^(Сегодня|\d+ [а-я]+) · 3 матча$/);
  assert.match(text(sec(ctx, "goals").querySelector(".v27Head")), /Голы в эфире/);
  const hero = sec(ctx, "hero");
  assert.ok(hero.querySelector(".v27Kicker .v27LiveBadge"), "no cover: the red LIVE sits in the title line");
  assert.equal(text(hero.querySelector(".v27HeroMid strong")), "1 : 0");
  assert.equal(text(hero.querySelector(".v27HeroMid small")), "2-й период · 14:32");
  assert.match(text(hero.querySelector(".v27Cta")), /Смотреть матч в VK Видео/);
  assert.ok(ctx.timers.includes(15000), "a game is on: the page asks again every 15 seconds");
  ctx.window.close();

  // a cover on the card: the LIVE badge goes onto the picture
  const covered = makeHome({ data: homeData({ mode: "live", featured: featured({ game_state: "LIVE", away_score: 2, home_score: 2, cover_url: "https://clips.test/covers/1.jpg" }) }) });
  await tick(420);
  const cardHero = sec(covered, "hero");
  assert.equal(cardHero.querySelector(".v27HeroCover img").getAttribute("src"), "https://clips.test/covers/1.jpg");
  assert.ok(cardHero.querySelector(".v27HeroCover .v27LiveBadge"));
  assert.ok(!cardHero.querySelector(".v27Kicker .v27LiveBadge"));
  // the cover fails to load: the card falls back to the logos and remembers the failure
  const img = cardHero.querySelector(".v27HeroCover img");
  img.dispatchEvent(new covered.window.Event("error"));
  await tick(10);
  assert.ok(!sec(covered, "hero").querySelector(".v27HeroCover"), "without the picture the logos stay");
  assert.ok(covered.window.HOHCoverFailures.has("https://clips.test/covers/1.jpg"));
  covered.window.close();

  // not live: a minute is enough
  const quiet = makeHome();
  await tick(420);
  assert.ok(quiet.timers.includes(60000));
  assert.ok(!quiet.timers.includes(15000));
  quiet.window.close();

  // a finished match of the day
  const done = makeHome({ data: homeData({ featured: featured({ game_state: "OFF", away_score: 3, home_score: 2, period_type: "SO" }) }) });
  await tick(420);
  assert.match(text(sec(done, "hero").querySelector(".v27HeroMid")), /3 : 2ФИНАЛ · Б/);
  assert.match(text(sec(done, "hero").querySelector(".v27Cta")), /Смотреть запись в VK Видео/);
  done.window.close();
}

{
  // taps: a game of the strip, the card, the odds, "Все матчи", the news
  const ctx = makeHome();
  await tick(420);
  sec(ctx, "strip").querySelector(".v27Chip").click();
  assert.deepEqual(plain(ctx.opened.pop()), { pk: 1, ctx: { returnTab: "games" } }, "a chip opens the match screen and comes back to the home page");
  sec(ctx, "hero").querySelector(".v27HeroTeams").click();
  assert.equal(ctx.opened.pop().pk, 2026020094, "the card opens the match");
  sec(ctx, "hero").querySelector(".v27Odd").addEventListener("click", (e) => e.preventDefault());
  sec(ctx, "hero").querySelector(".v27Odd").click();
  sec(ctx, "hero").querySelector(".v27Cta").addEventListener("click", (e) => e.preventDefault());
  sec(ctx, "hero").querySelector(".v27Cta").click();
  assert.equal(ctx.opened.length, 0, "a link on the card does not open the match screen");
  let broadcasts = 0;
  ctx.document.querySelector('.tab[data-tab="broadcasts"]').addEventListener("click", () => { broadcasts += 1; });
  sec(ctx, "strip").querySelector(".v27Head [data-v27-all]").click();
  assert.equal(broadcasts, 1, "'Все матчи' opens the Matches tab");
  ctx.window.close();
}

{
  // the goal player: opens over the page, plays, goes on by itself, jumps to the match
  const ctx = makeHome();
  await tick(420);
  const shelf = () => [...sec(ctx, "goals").querySelectorAll(".v27Goal")];
  shelf()[1].click();
  const ov = ctx.document.getElementById("v27Ov");
  assert.ok(ov, "the player opens");
  assert.equal(ov.querySelector("video").getAttribute("src"), "https://clips.test/tg/12.mp4");
  assert.equal(ov.querySelector("video").getAttribute("poster"), "https://clips.test/p/12.jpg");
  assert.ok(ov.querySelector("video").hasAttribute("playsinline"), "inline on the phone");
  assert.match(text(ov), /Гол 2 из 3/);
  assert.match(text(ov), /William Karlsson/);
  assert.match(text(ov), /VGK 2:3 MIN · 3-й 09:25/);
  assert.ok(ctx.document.documentElement.classList.contains("v27OvOpen"), "the page behind does not scroll");
  ov.querySelector('[data-v27-ov="prev"]').click();
  assert.equal(ctx.document.querySelector("#v27Ov video").getAttribute("src"), "https://clips.test/tg/11.mp4");
  assert.ok(ctx.document.querySelector('#v27Ov [data-v27-ov="prev"]').hasAttribute("disabled"), "nothing before the first goal");
  ctx.document.querySelector("#v27Ov video").dispatchEvent(new ctx.window.Event("ended"));
  assert.equal(ctx.document.querySelector("#v27Ov video").getAttribute("src"), "https://clips.test/tg/12.mp4", "the next goal starts by itself");
  ctx.document.querySelector("#v27Ov video").dispatchEvent(new ctx.window.Event("ended"));
  assert.equal(ctx.document.querySelector("#v27Ov video").getAttribute("src"), "https://clips.test/tg/13.mp4");
  ctx.document.querySelector("#v27Ov video").dispatchEvent(new ctx.window.Event("ended"));
  assert.equal(ctx.document.querySelector("#v27Ov video").getAttribute("src"), "https://clips.test/tg/13.mp4", "the last goal stays");
  assert.ok(ctx.document.querySelector('#v27Ov [data-v27-ov="next"]').hasAttribute("disabled"));
  ctx.document.querySelector("#v27Ov video").dispatchEvent(new ctx.window.Event("error"));
  assert.ok(!ctx.document.querySelector("#v27Ov .v27OvErr").hidden, "a broken file says so");
  ctx.document.querySelector('#v27Ov [data-v27-ov="match"]').click();
  assert.ok(!ctx.document.getElementById("v27Ov"), "'К матчу' closes the player");
  assert.deepEqual(plain(ctx.opened.pop()), { pk: 3, ctx: { returnTab: "games" } });
  assert.ok(!ctx.document.documentElement.classList.contains("v27OvOpen"));
  shelf()[0].click();
  ctx.document.querySelector('#v27Ov [data-v27-ov="close"]').click();
  assert.ok(!ctx.document.getElementById("v27Ov"));
  shelf()[0].click();
  ctx.document.getElementById("v27Ov").click();
  assert.ok(!ctx.document.getElementById("v27Ov"), "a tap on the dark side closes it too");
  ctx.window.close();
}

{
  // no spoilers: scores are hidden everywhere, the goals wait behind a button
  const ctx = makeHome({ data: homeData({ featured: featured({ game_state: "OFF", away_score: 3, home_score: 2 }) }), spoilers: true });
  await tick(420);
  const chips = [...sec(ctx, "strip").querySelectorAll(".v27Chip")].map(text);
  assert.ok(chips.every((c) => !/\d : \d/.test(c) && /•/.test(c)), "no score on a chip");
  assert.ok(!/3 : 2/.test(text(sec(ctx, "hero"))) && /•/.test(text(sec(ctx, "hero"))), "no score on the card");
  assert.ok(!sec(ctx, "goals").querySelector(".v27Goal"), "no goals, no names, no pictures with a score in the corner");
  assert.match(text(sec(ctx, "goals")), /без спойлеров/);
  assert.ok(!/Эрикссон/.test(sec(ctx, "goals").innerHTML));
  sec(ctx, "goals").querySelector("[data-v27-reveal]").click();
  assert.equal(sec(ctx, "goals").querySelectorAll(".v27Goal").length, 3, "the viewer asked for them");
  // the eye is switched on again: hidden again
  ctx.box.spoilers = true;
  ctx.window.dispatchEvent(new ctx.window.Event("hoh-spoilers-change"));
  assert.ok(!sec(ctx, "goals").querySelector(".v27Goal"));
  // the eye is off: everything is back
  ctx.box.spoilers = false;
  ctx.window.dispatchEvent(new ctx.window.Event("hoh-spoilers-change"));
  assert.match(text(sec(ctx, "strip").querySelector(".v27Chip")), /3 : 5/);
  assert.equal(sec(ctx, "goals").querySelectorAll(".v27Goal").length, 3);
  ctx.window.close();
}

{
  // the news page: the tapped one is open at the top, the others below, comments work
  const ctx = makeHome({ comments: { 301: [{ author: "Иван", body: "Отличный гол!", created_at: iso(Date.now() - 60000) }] } });
  await tick(420);
  sec(ctx, "news").querySelectorAll(".v27News")[1].click();
  await tick(60);
  const page = ctx.document.querySelector(".v27NewsPage");
  assert.ok(page, "the news page");
  assert.ok(ctx.H.state.profile, "the page is a screen of its own");
  assert.equal(ctx.document.getElementById("tabs").style.display, "none");
  assert.ok(page.classList.contains("v20Detail"), "the eye and the gear go into the back row");
  assert.equal(text(ctx.document.querySelector(".v27Article h1")), "Вторая новость", "the tapped news is open");
  assert.match(text(ctx.document.querySelector(".v27Article")), /Sports\.ru/);
  const src = ctx.document.querySelector(".v27Article .v27Src");
  assert.ok(src, "a link to the source: the full text is there");
  assert.equal(src.getAttribute("href"), "https://www.sports.ru/hockey/1234567-test.html");
  assert.equal(src.getAttribute("target"), "_blank");
  assert.match(text(src), /Читать на sports\.ru/);
  assert.match(text(ctx.document.querySelector(".v27Article .none")), /Полный текст — на сайте источника/);
  const others = [...ctx.document.querySelectorAll(".v27NCard")];
  assert.deepEqual(others.map((c) => c.dataset.v27Open), ["301", "303", "304", "305"], "all the other news below, the open one is not repeated");
  assert.match(text(ctx.document.getElementById("v27NList")), /Другие новости/);
  assert.match(text(others[2]), /Текст четвёртой новости/, "a preview when the text is known");
  assert.ok(!others[1].querySelector(".p"), "no preview when it is not");
  assert.ok(ctx.document.getElementById("v27Comments").compareDocumentPosition(ctx.document.getElementById("v27NList")) & 4, "the comments are above the other news");
  assert.match(text(ctx.document.getElementById("v27Comments")), /Пока никто не комментировал/);

  // another news from the list takes the top place
  others[0].click();
  await tick(60);
  assert.deepEqual(plain(ctx.window.scrolls.at(-1)), [0, 0], "a new article opens at the top of the page");
  assert.equal(text(ctx.document.querySelector(".v27Article h1")), NEWS[0].title);
  assert.match(text(ctx.document.querySelector(".v27Article .body")), /Полный текст первой новости/);
  assert.match(text(ctx.document.getElementById("v27Comments")), /Иван.*Отличный гол!/);
  assert.equal(text(ctx.document.getElementById("v27CCount")), "1");
  assert.deepEqual([...ctx.document.querySelectorAll(".v27NCard")].map((c) => c.dataset.v27Open), ["302", "303", "304", "305"], "the first one left the list, the second came back");

  // write a comment
  ctx.document.getElementById("v27CText").value = "  Согласен!  ";
  ctx.document.getElementById("v27CSend").click();
  await tick(60);
  assert.deepEqual(plain(ctx.posted), [{ id: 301, body: "Согласен!" }]);
  assert.equal(ctx.document.getElementById("v27CText").value, "", "the field is empty after sending");
  assert.match(text(ctx.document.getElementById("v27Comments")), /Согласен!/);
  assert.equal(text(ctx.document.getElementById("v27CCount")), "2");
  ctx.document.getElementById("v27CSend").click();
  await tick(20);
  assert.equal(ctx.posted.length, 1, "an empty comment is not sent");
  ctx.window.HOHEnsureCommentIdentity = async () => false;
  ctx.document.getElementById("v27CText").value = "без имени";
  ctx.document.getElementById("v27CSend").click();
  await tick(20);
  assert.equal(ctx.posted.length, 1, "no name chosen: nothing is sent");

  // back: the tabs are back and the home page is rebuilt, with the counter updated
  ctx.document.getElementById("v15Back").click();
  await tick(320);
  assert.equal(ctx.H.state.profile, false);
  assert.equal(ctx.document.getElementById("tabs").style.display, "grid");
  const rebuilt = ctx.document.querySelector("#view > .v27Home");
  assert.ok(rebuilt, "the home page comes back");
  assert.equal(text(sec(ctx, "news").querySelector(".v27News .cm")), "2", "the new comment is in the counter");
  assert.equal(sec(ctx, "news").querySelectorAll(".v27News").length, 3);
  assert.equal(sec(ctx, "goals").querySelectorAll(".v27Goal").length, 3, "the home page is drawn from what it already knows, without a blank screen");
  ctx.window.close();
}

{
  // "Все новости": the whole feed, nothing open
  const ctx = makeHome();
  await tick(420);
  sec(ctx, "news").querySelector("[data-v27-news-all]").click();
  await tick(60);
  assert.ok(ctx.document.querySelector(".v27NewsPage"));
  assert.ok(!ctx.document.querySelector(".v27Article"), "no article is open");
  assert.equal(ctx.document.querySelectorAll(".v27NCard").length, 5);
  assert.match(text(ctx.document.getElementById("v27NList")), /Свежее в НХЛ/);
  ctx.document.querySelectorAll(".v27NCard")[3].click();
  await tick(60);
  assert.equal(text(ctx.document.querySelector(".v27Article h1")), "Четвёртая новость");
  assert.equal(ctx.document.querySelectorAll(".v27NCard").length, 4);
  // a link that is not a web link is never put on the page
  await ctx.S.openNews(303);
  assert.equal(text(ctx.document.querySelector(".v27Article h1")), "Третья новость");
  assert.ok(!ctx.document.querySelector(".v27Article .v27Src"), "no javascript: links");
  assert.match(text(ctx.document.querySelector(".v27Article .none")), /Полный текст пока не подгрузился/);
  ctx.window.close();

  // a news that is not in the list: asked for by its number, and a clear message when it does not exist
  const lone = makeHome({ news: [] });
  await tick(420);
  await lone.S.openNews(777);
  assert.match(text(lone.document.querySelector(".v27NewsPage")), /Не удалось загрузить новость/);
  lone.window.close();
}

{
  // leaving the tab takes the page away, coming back builds it again; stray old blocks are swept
  const ctx = makeHome();
  await tick(420);
  ctx.document.querySelector('.tab[data-tab="teams"]').click();
  await tick(250);
  assert.ok(!ctx.document.querySelector(".v27Home"), "another tab: no home page in it");
  assert.equal(text(ctx.document.getElementById("view")), "tab");
  ctx.document.querySelector('.tab[data-tab="games"]').click();
  await tick(400);
  assert.ok(ctx.document.querySelector("#view > .v27Home"), "back on the home tab");
  const view = ctx.document.getElementById("view");
  view.insertAdjacentHTML("afterbegin", '<section class="v15Media">old</section><section class="v20News">old</section><section class="v25FeaturedGame">old</section>');
  ctx.S.mount();
  assert.ok(!ctx.document.querySelector(".v15Media, .v20News, .v25FeaturedGame"), "old blocks are swept away");
  // the match screen replaced the page: nothing of the home page is left to hide the match
  ctx.H.state.profile = true;
  view.innerHTML = '<div class="v15Profile">match</div>';
  ctx.S.mount();
  assert.equal(text(view), "match");
  ctx.window.close();
}

{
  // nothing changed: the page is not touched (no flicker, the shelf keeps its place)
  const ctx = makeHome();
  await tick(420);
  const home = ctx.document.querySelector(".v27Home");
  let touched = 0;
  const mo = new ctx.window.MutationObserver((records) => { touched += records.length; });
  mo.observe(home, { childList: true, subtree: true, attributes: true, characterData: true });
  await ctx.S.refresh();
  await tick(10);
  assert.equal(touched, 0, "the same answer repaints nothing");
  // a new goal: only the shelf changes
  ctx.box.data = homeData({ goals: { ...homeData().goals, total: 21, items: [tile(14, 3, "New Guy", "Новый Игрок", "MIN", 3, "19:59", 2, 5), ...homeData().goals.items] } });
  await ctx.S.refresh();
  assert.equal(sec(ctx, "goals").querySelectorAll(".v27Goal").length, 4);
  assert.match(text(sec(ctx, "goals").querySelector(".v27Goal")), /Игрок/);
  mo.disconnect();
  ctx.window.close();
}

{
  // the home answer is down: a stale page stays, but a page that never loaded gives way to the old home
  const ctx = makeHome({ failHome: true });
  await tick(420);
  await ctx.S.refresh();
  await tick(20);
  assert.equal(ctx.window.HOHV27.owns(), false, "twice without an answer: the old home takes over");
  assert.ok(!ctx.document.querySelector(".v27Home"));
  assert.ok(ctx.H.runs >= 1, "the old layers are asked to draw the home page");
  ctx.window.close();

  const stale = makeHome();
  await tick(420);
  assert.ok(stale.document.querySelector(".v27Home .v27Chip"));
  stale.box.failHome = true;
  await stale.S.refresh();
  await stale.S.refresh();
  assert.equal(stale.window.HOHV27.owns(), true, "a page that has shown data keeps it when one update fails");
  assert.ok(stale.document.querySelector(".v27Home .v27Chip"));
  stale.window.close();

  // nothing to show: no empty frames
  const empty = makeHome({ data: homeData({ mode: "idle", games: [], featured: null, goals: { ok: false, day: null, live: false, total: 0, items: [] } }), news: [], media: [] });
  await tick(420);
  for (const name of ["strip", "hero", "goals", "news", "videos"]) assert.ok(sec(empty, name).hidden, `${name}: hidden when empty`);
  empty.window.close();
}

{
  // the script loaded twice: the second copy does nothing
  const ctx = makeHome();
  const before = ctx.window.HOHV27;
  ctx.window.eval(v27);
  assert.equal(ctx.window.HOHV27, before);
  ctx.window.close();
}

console.log("home v27 validation passed");
