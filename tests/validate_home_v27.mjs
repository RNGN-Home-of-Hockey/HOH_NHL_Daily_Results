// Live Center home page (v27): the mood of the page (live / results / schedule), the score strip, the goals shelf, the match of the day,
// three news with the news page, the videos, no-spoilers mode and the fallback to the old home.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import {
  nhlDateOf, gameFromRow, pickHome, stripOf, periodShort, playedTime, goalMoment, buildGoalTiles, applyNames, applyHeroLive, buildHomePayload,
  GOALS_WINDOW_MS, MAX_TILES, MIN_TILES, resultsEnd,
} from "../cloudflare-worker/src/telegram-center-v27-home-data.js";
import { buildRussians, statLine, MAX_RUSSIANS } from "../cloudflare-worker/src/telegram-center-v27-russians.js";
import { applyGoalCounts } from "../cloudflare-worker/src/telegram-center-v27-home-data.js";
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

  // the results of the night stay until 12:00 UTC (15:00 Moscow time), then the schedule of the next night
  const night = Date.parse("2026-10-13T02:00:00Z");
  const evening = (state, ofH, extra) => game(ofH, state, { base: Date.parse("2026-10-13T00:00:00Z"), ...extra });
  const nightGames = [evening("OFF", 2, { a: 3, h: 2 }), evening("OFF", 1, { a: 1, h: 0 }), evening("FUT", 23)];
  assert.equal(pickHome(nightGames, Date.parse("2026-10-13T11:59:00Z")).mode, "results", "before 15:00 Moscow time: last night");
  assert.equal(pickHome(nightGames, Date.parse("2026-10-13T11:59:00Z")).stripDay, nightGames[0].date);
  assert.equal(pickHome(nightGames, Date.parse("2026-10-13T12:01:00Z")).mode, "schedule", "after 15:00: the next night");
  assert.equal(pickHome(nightGames, Date.parse("2026-10-13T12:01:00Z")).stripDay, nightGames[2].date);
  assert.equal(pickHome(nightGames, Date.parse("2026-10-13T08:00:00Z")).mode, "results", "even in the middle of the morning");
  assert.equal(resultsEnd(night), Date.parse("2026-10-13T12:00:00Z"));
  assert.equal(resultsEnd(Date.parse("2026-10-13T23:00:00Z")), Date.parse("2026-10-14T12:00:00Z"), "a game that started in the evening: until noon of the next day");
  assert.equal(resultsEnd(Date.parse("2026-10-13T12:00:00Z")), Date.parse("2026-10-14T12:00:00Z"), "exactly at the boundary: the next one");

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

  // goals of Russian players go first, then the rest; the newest first inside each group
  const ruShelf = buildGoalTiles({ games, index, indexOk: true, now: NOW, clipsBase: BASE, russianIds: new Set([4, 1]) });
  assert.deepEqual(ruShelf.items.map((t) => t.event_id), [101, 201, 102, 202], "Russians (1 and 4) first: the goal of 1 and the goal of 4, then the others");
  assert.deepEqual(ruShelf.items.map((t) => t.russian), [true, true, false, false]);
  assert.ok(buildGoalTiles({ games, index, indexOk: true, now: NOW, clipsBase: BASE }).items.every((t) => t.russian === false), "no list of Russians: nothing is marked");
  // the number of the goal in the season is only for Russians
  applyGoalCounts(ruShelf, new Map([["21:101", 6], ["21:102", 9], ["22:201", 1]]));
  assert.deepEqual(ruShelf.items.map((t) => t.season_goal), [6, 1, null, null], "known counts for Russians; a count for someone else is ignored");
  assert.equal(applyGoalCounts({ items: [{ game_pk: 1, event_id: 2, russian: true, season_goal: null }] }, { "1:2": "x" }).items[0].season_goal, null, "a number that is not a number is ignored");

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

// ---- 2b) Russians of the day ------------------------------------------------------------------------------------------------------
{
  const finalGame = game(-5, "OFF", { pk: 51, away: "VGK", home: "MIN", a: 2, h: 4 });
  const upcomingGame = game(20, "FUT", { pk: 52, away: "SEA", home: "PHI" });
  const postponed = game(3, "PPD", { pk: 53, away: "COL", home: "DAL" });
  const p = (id, nameRu, tri, pos = "C") => ({ player_id: id, full_name_ru: nameRu, full_name_en: `En ${id}`, current_team_tri: tri, position_code: pos, sweater_number: id % 100 });
  const players = [
    p(1, "Кирилл Капризов", "MIN", "L"), p(2, "Филипп Червяков", "MIN", "G"), p(3, "Иван Баранов", "MIN", "D"), p(4, "Пётр Скрытый", "VGK", "C"),
    p(5, "Андрей Свечников", "SEA"), p(6, "Матвей Мичков", "PHI"), p(7, "Не Играет", "COL"), p(8, "Пропустил Игру", "MIN"),
  ];
  const skater = (id, goals, assists, toi) => ({ playerId: id, goals, assists, points: goals + assists, toi });
  const box = {
    playerByGameStats: {
      awayTeam: { forwards: [skater(4, 0, 0, "00:00")], defense: [], goalies: [] },
      homeTeam: { forwards: [skater(1, 2, 1, "19:10")], defense: [skater(3, 0, 0, "21:30")], goalies: [{ playerId: 2, toi: "60:00", saves: 27, shotsAgainst: 29, goalsAgainst: 2 }, { playerId: 99, toi: "00:00", saves: 0, shotsAgainst: 0 }] },
    },
  };
  const items = buildRussians({ games: [finalGame, upcomingGame, postponed], players, boxes: new Map([[51, box]]), season: "20262027" });
  assert.deepEqual(items.map((i) => i.player_id), [1, 3, 2, 5, 6], "who scored first, then the others who played, then the ones whose game is ahead; a postponed game and players who did not skate are left out");
  const kaprizov = items[0];
  assert.deepEqual(plain(kaprizov.line), { kind: "s", goals: 2, assists: 1, points: 3, toi: "19:10" });
  assert.equal(kaprizov.team, "MIN");
  assert.equal(kaprizov.opp, "VGK");
  assert.equal(kaprizov.home, true);
  assert.equal(kaprizov.phase, "final");
  assert.equal(kaprizov.game_pk, 51);
  assert.equal(kaprizov.name_ru, "Кирилл Капризов");
  assert.equal(kaprizov.photo, "https://assets.nhle.com/mugs/nhl/20262027/MIN/1.png");
  assert.ok(!("rank" in kaprizov) && !("start_ms" in kaprizov), "the internal sorting keys are not published");
  assert.deepEqual(plain(items.find((i) => i.player_id === 2).line), { kind: "g", saves: 27, shots: 29, goals_against: 2, toi: "60:00" }, "a goalie: saves and shots");
  assert.equal(items.find((i) => i.player_id === 5).line, null, "a game that has not started: no line yet");
  assert.equal(items.find((i) => i.player_id === 5).home, false);
  // no box score for a finished game (the NHL did not answer): the players stay, without a line
  const noBox = buildRussians({ games: [finalGame], players, boxes: new Map(), season: "20262027" });
  assert.deepEqual(noBox.map((i) => i.player_id).sort(), [1, 2, 3, 4, 8]);
  assert.ok(noBox.every((i) => i.line === null));
  assert.equal(statLine(null), null);
  assert.equal(statLine({ row: { toi: "00:00" }, goalie: false }), null);
  // a long day: the list is cut, nobody is lost from the top
  const crowd = Array.from({ length: 40 }, (_, i) => p(1000 + i, `Игрок ${i}`, "SEA"));
  assert.equal(buildRussians({ games: [upcomingGame], players: crowd, boxes: {}, season: "20262027" }).length, MAX_RUSSIANS);
  assert.deepEqual(buildRussians({ games: [], players, boxes: {} }), []);
}

// ---- 3) the route---------------------------------------------------------------------------------------------------------------
{
  const calls = [];
  const deps = {
    loadGames: async () => [game(-5, "OFF", { pk: 41, away: "VGK", home: "MIN", a: 2, h: 3 }), game(20, "FUT", { pk: 42, away: "SEA", home: "PHI" })],
    loadFeatured: async (_env, day) => { calls.push(["featured", day]); return { game_pk: 42, game_state: "FUT", away: { tri: "SEA" }, home: { tri: "PHI" } }; },
    loadIndex: async (base) => { calls.push(["index", base]); return { games: [{ game_pk: 41, goals: [goal(701, 1, "10:00", 0, 1, 9, "Joel Eriksson Ek", "MIN"), goal(702, 2, "10:00", 0, 2, 10, "Someone Else", "MIN")] }] }; },
    loadNames: async (_env, ids) => { calls.push(["names", ids]); return new Map([[9, "Юэль Эрикссон Эк"]]); },
    loadHeroLive: async () => { throw new Error("not live"); },
    loadRussians: async (_env, dayGames) => { calls.push(["russians", dayGames.map((g) => g.game_pk)]); return [{ player_id: 1, team: "VGK" }]; },
    loadRussianIds: async () => new Set([9]),
    loadGoalCounts: async (tiles) => { calls.push(["counts", tiles.map((t) => t.event_id)]); return new Map([["41:701", 7]]); },
  };
  const payload = await loadHomePayload({ HOH_CLIPS_BASE: "https://other.test/" }, { now: NOW, deps });
  assert.deepEqual(plain(payload.russians), { ok: true, day: payload.strip_day, items: [{ player_id: 1, team: "VGK" }] });
  assert.deepEqual(calls.find((c) => c[0] === "russians"), ["russians", [41]], "the Russians are looked up for the games of the strip");
  assert.equal(payload.ok, true);
  assert.equal(payload.version, "27.0");
  assert.equal(payload.mode, "results");
  assert.equal(payload.games.length, 1);
  assert.equal(payload.games[0].game_pk, 41);
  assert.equal(payload.featured.game_pk, 42);
  assert.deepEqual(calls.find((c) => c[0] === "featured"), ["featured", payload.hero_day], "the match of the day is asked for the day it looks at");
  assert.deepEqual(calls.find((c) => c[0] === "index"), ["index", "https://other.test"], "the clip server base can be changed in the settings");
  assert.deepEqual(calls.find((c) => c[0] === "names"), ["names", [9, 10]], "names of all scorers on the shelf");
  assert.equal(payload.goals.items[1].russian, false, "the other scorer is not Russian and comes second");
  assert.equal(payload.goals.items[0].russian, true, "the scorer is in the list of Russians");
  assert.equal(payload.goals.items[0].season_goal, 7, "and the number of his goal in the season is on the tile");
  assert.deepEqual(calls.find((c) => c[0] === "counts"), ["counts", [701]], "goal counts are asked only for goals of Russians");
  assert.equal(payload.goals.items[0].scorer_ru, "Юэль Эрикссон Эк");
  assert.equal(payload.goals.items[0].clip_url, "https://other.test/tg/701.mp4");

  // every helper may fail: the page still answers with what it has
  const broken = await loadHomePayload({}, { now: NOW, deps: { ...deps, loadFeatured: async () => { throw new Error("db"); }, loadIndex: async () => { throw new Error("offline"); }, loadNames: async () => { throw new Error("db"); } } });
  assert.equal(broken.ok, true);
  assert.equal(broken.featured, null);
  assert.equal(broken.goals.ok, false);
  assert.equal(broken.games.length, 1);
  const noIds = await loadHomePayload({}, { now: NOW, deps: { ...deps, loadRussianIds: async () => { throw new Error("db"); }, loadGoalCounts: async () => { throw new Error("nhl"); } } });
  assert.equal(noIds.ok, true, "no list of Russians: the shelf is in the usual order");
  assert.equal(noIds.goals.items[0].russian, false);
  const noCounts = await loadHomePayload({}, { now: NOW, deps: { ...deps, loadGoalCounts: async () => { throw new Error("nhl"); } } });
  assert.equal(noCounts.goals.items[0].season_goal, null, "the NHL does not answer: the goal is there without a number");
  const noRussians = await loadHomePayload({}, { now: NOW, deps: { ...deps, loadRussians: async () => { throw new Error("db"); } } });
  assert.equal(noRussians.ok, true, "no Russians: the rest of the page is fine");
  assert.deepEqual(plain(noRussians.russians), { ok: false, day: noRussians.strip_day, items: [] });
  const oldDeps = { ...deps };
  delete oldDeps.loadRussians;
  assert.equal((await loadHomePayload({}, { now: NOW, deps: oldDeps })).russians.ok, true, "callers without a Russians loader get an empty list");

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
  const env = { DB: db([row(7001, -5, "OFF", { vk_url: "https://vkvideo.ru/video-1_77" }), row(7002, 20, "FUT")]) };
  const first = await handleTelegramCenterV27(new Request("https://x.test/api/telegram-center-v27/home"), env, "/api/telegram-center-v27/home");
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control"), /max-age=10/);
  const body = await first.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "results");
  assert.ok(body.games.length >= 1);
  assert.equal(body.featured.game_pk, 7002, "the match of the day is a game that has not finished yet (the home page asks the featured endpoint with focus=now)");
  assert.ok(sqls.some((s) => /FROM games g/.test(s) && /scheduled_start_utc>=\?/.test(s)), "the games of the window are read in one query");
  assert.ok(sqls.some((s) => /FROM games g/.test(s) && /LEFT JOIN game_vk_broadcasts gvb ON gvb\.game_pk=g\.game_pk/.test(s) && /LEFT JOIN vk_broadcasts vb ON vb\.source_key=gvb\.source_key/.test(s) && /vb\.web_url vk_url/.test(s)), "with the link to watch of each game");
  assert.ok(sqls.some((s) => /player_profile_meta/.test(s) && /primary_country_code='RUS'/.test(s) && /current_team_tri IN/.test(s)), "the Russians of the teams that play are read in one query");
  assert.equal(body.russians.ok, true);
  assert.equal(body.games[0].vk_url, "https://vkvideo.ru/video-1_77", "the link to watch reaches the page");
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
  // the match of the day carries the record of both teams (wins, losses, overtime losses, points)
  const recDb = { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: /FROM standings_snapshots/.test(sql) ? [{ team_tri: "PHI", games_played: 6, wins: 4, losses: 1, ot_losses: 1, points: 9, league_rank: 3 }] : [row(8100, 2, "FUT")] }), first: async () => null }), all: async () => ({ results: [] }) }) };
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, covers: {} }), { status: 200 });
  const withRecord = (await (await handleTelegramCenterV19ProductData(new Request("https://x.test/api/telegram-center-v19/featured?date=2026-10-12"), { HOH_CLIPS_BASE: BASE, DB: recDb }, "/api/telegram-center-v19/featured")).json()).featured;
  assert.deepEqual(plain(withRecord.away_record), { gp: 6, w: 4, l: 1, otl: 1, pts: 9 }, "PHI (the away side in this fixture) has a record");
  assert.equal(withRecord.home_record, null, "a team without a standings row has none");

  // the table of the NHL is read live: with empty standings snapshots (as in production) every game used to look equally strong and
  // the first one by time won; now the stronger pair is the match of the day, and the records come from the live table
  const weak = row(9001, 2, "FUT", { home_tri: "CHI", away_tri: "ANA" });
  const strong = row(9002, 5, "FUT", { home_tri: "CAR", away_tri: "TBL" });
  const emptyStandingsDb = { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: /FROM standings_snapshots|FROM subscriptions/.test(sql) ? [] : [weak, strong] }), first: async () => null }), all: async () => ({ results: [] }) }) };
  const table = (tri, gp, w, l, otl, pts, rank) => ({ teamAbbrev: { default: tri }, gamesPlayed: gp, wins: w, losses: l, otLosses: otl, points: pts, leagueSequence: rank });
  let standingsAsked = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("standings/now")) {
      standingsAsked += 1;
      return new Response(JSON.stringify({ standings: [table("CAR", 6, 6, 0, 0, 12, 1), table("TBL", 6, 5, 1, 0, 10, 2), table("CHI", 6, 0, 5, 1, 1, 31), table("ANA", 6, 1, 4, 1, 3, 28)] }), { status: 200 });
    }
    return new Response(JSON.stringify({ version: 1, covers: {} }), { status: 200 });
  };
  const askLive = async (db) => (await (await handleTelegramCenterV19ProductData(new Request("https://x.test/api/telegram-center-v19/featured?date=2026-10-12"), { HOH_CLIPS_BASE: BASE, DB: db }, "/api/telegram-center-v19/featured")).json()).featured;
  const chosen = await askLive(emptyStandingsDb);
  assert.equal(chosen.game_pk, 9002, "the stronger pair wins although it starts later");
  assert.ok(standingsAsked >= 1, "the live table is asked for");
  assert.deepEqual(plain(chosen.home_record), { gp: 6, w: 6, l: 0, otl: 0, pts: 12 }, "records come from the live table when the snapshots are empty");
  assert.deepEqual(plain(chosen.away_record), { gp: 6, w: 5, l: 1, otl: 0, pts: 10 });
  assert.ok(chosen.signals.home_win_pct > 0.9, "and the strength of the team is known");
  // an old row in the database does not hide the live table
  const staleDb = { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: /FROM standings_snapshots/.test(sql) ? [{ team_tri: "CAR", games_played: 2, wins: 0, losses: 2, ot_losses: 0, points: 0, league_rank: 30 }] : /FROM subscriptions/.test(sql) ? [] : [weak, strong] }), first: async () => null }), all: async () => ({ results: [] }) }) };
  assert.equal((await askLive(staleDb)).home_record.w, 6, "the live table is newer than the snapshot");
  // the NHL does not answer: the old behaviour, the first game by time
  globalThis.fetch = async (url) => (String(url).includes("standings/now") ? new Response("no", { status: 502 }) : new Response(JSON.stringify({ version: 1, covers: {} }), { status: 200 }));
  assert.equal((await askLive(emptyStandingsDb)).game_pk, 9001, "no live table and no snapshots: the first game by time, as before");
  globalThis.fetch = async (url) => { if (String(url).includes("standings/now")) throw new Error("offline"); return new Response(JSON.stringify({ version: 1, covers: {} }), { status: 200 }); };
  assert.equal((await askLive(emptyStandingsDb)).game_pk, 9001, "the request fails outright: the same");
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
  game_pk: pk, date: localDay(), start: iso(Date.now() + startOffsetH * HOUR), state: phase === "live" ? "LIVE" : phase === "final" ? "OFF" : "FUT", phase, is_playoff: false, vk_url: `https://vkvideo.ru/video-1_${pk}`,
  away: { tri: away, name_ru: `${away} ру`, logo: logo(away) }, home: { tri: home, name_ru: `${home} ру`, logo: logo(home) }, away_score: a, home_score: h, finish,
});
const tile = (event, pk, name, nameRu, team, period, time, a, h, extra = {}) => ({
  game_pk: pk, event_id: event, date: localDay(), live: false, russian: false, season_goal: null, team, scorer_id: event, scorer_ru: nameRu, scorer_en: name, period, period_short: `${period}-й`, time,
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
const ru = (id, nameRu, team, opp, home, phase, line, extra = {}) => ({
  player_id: id, name_ru: nameRu, name_en: `En ${id}`, position: "C", number: 9, team, opp, home, game_pk: 3, phase,
  start: iso(Date.now() + (phase === "upcoming" ? 20 : -6) * HOUR), line, photo: `https://assets.test/${id}.png`, ...extra,
});
const homeData = (extra = {}) => ({
  ok: true, version: "27.0", mode: "results", today: localDay(), strip_day: localDay(), hero_day: localDay(),
  games: [chip(1, "FLA", "BUF", "final", 3, 5, -10), chip(2, "OTT", "NJD", "final", 4, 1, -9, "OT"), chip(3, "VGK", "MIN", "final", 2, 4, -8)],
  featured: featured(),
  russians: {
    ok: true, day: localDay(),
    items: [
      ru(1, "Кирилл Капризов", "MIN", "VGK", true, "final", { kind: "s", goals: 2, assists: 1, points: 3, toi: "19:10" }),
      ru(2, "Филипп Червяков", "MIN", "VGK", true, "final", { kind: "g", saves: 27, shots: 29, goals_against: 2, toi: "60:00" }),
      ru(5, "Андрей Свечников", "SEA", "PHI", false, "upcoming", null),
    ],
  },
  goals: { ok: true, day: localDay(), live: false, total: 20, items: [tile(11, 3, "Joel Eriksson Ek", "Юэль Эрикссон Эк", "MIN", 3, "18:38", 2, 4), tile(12, 3, "William Karlsson", "", "VGK", 3, "09:25", 2, 3), tile(13, 3, "Rasmus Andersson", "Расмус Андерссон", "VGK", 2, "02:37", 1, 3)] },
  ...extra,
});

function makeHome({ data = homeData(), news = NEWS, media = MEDIA, comments = {}, failHome = false, spoilers = false, tabName = "games", follows = null, lookups = {}, stored = {}, followsDelay = 0, prefs = true } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button><button class="tab" data-tab="broadcasts"></button><button class="tab" data-tab="teams"></button><button class="tab" data-tab="follows"></button></nav>
     <main id="view" class="view"><div class="dateBox">2026-10-13</div><div class="toolbar"></div><div id="gameList"><article class="gameCard" data-game="1"></article></div></main></body>`,
    { url: "https://example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;
  const { document } = window;
  const timers = [];
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, ms, ...rest); };
  const box = { data, news: news.map((n) => ({ ...n })), media, comments, failHome, spoilers, follows, lookups };
  const players = [];
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
    openPlayer: (id) => players.push(id),
    runCore() { H.runs += 1; },
    api: async (url, opt) => {
      calls.push({ url, opt });
      if (url.startsWith("/api/telegram-center-v27/home")) { if (box.failHome) throw new Error("HTTP 500"); return box.data; }
      if (url.startsWith("/api/telegram-center-v20/news/home")) return { ok: true, news: box.news };
      if (url.startsWith("/api/telegram-center-v12/media")) return { ok: true, items: box.media };
      if (url === "/api/telegram-center-v2/subscriptions") {
        if (followsDelay) await new Promise((resolve) => setTimeout(resolve, followsDelay));
        if (box.follows === null) throw new Error("HTTP 401");
        return { ok: true, subscriptions: box.follows };
      }
      const lookup = /^\/api\/telegram-center-v17\/players\/(\d+)$/.exec(url);
      if (lookup) return { ok: true, player: { player_id: Number(lookup[1]), current_team_tri: box.lookups[lookup[1]] || null } };
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
    view().innerHTML = t.dataset.tab === "games" ? '<div class="toolbar"></div><div id="gameList"></div>' : t.dataset.tab === "follows" ? '<div id="v15Theme">theme</div><div id="other">follows</div>' : '<div id="other">tab</div>';
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
  const defaults = prefs ? { "hoh-home-mine-on": "1" } : {};
  for (const [key, value] of Object.entries({ ...defaults, ...stored })) window.localStorage.setItem(key, value);
  window.eval(v27);
  return { window, document, H, box, calls, opened, posted, players, timers, S: window.HOHV27 };
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

  assert.equal(sec(ctx, "russians").style.order, "2", "the Russians come right under the strip");
  assert.equal(sec(ctx, "goals").style.order, "3", "results: the goals come before the match of the day");
  assert.equal(sec(ctx, "hero").style.order, "4");
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
    assert.equal(sec(ctx, "russians").style.order, "2");
    assert.equal(sec(ctx, "hero").style.order, "3", `${mode}: the match of the day leads after the Russians`);
    assert.equal(sec(ctx, "goals").style.order, "4");
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
  const empty = makeHome({ data: homeData({ mode: "idle", games: [], featured: null, goals: { ok: false, day: null, live: false, total: 0, items: [] }, russians: { ok: false, day: null, items: [] } }), news: [], media: [] });
  await tick(420);
  for (const name of ["strip", "hero", "goals", "russians", "news", "videos"]) assert.ok(sec(empty, name).hidden, `${name}: hidden when empty`);
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

{
  // the match of the day: the record of both teams in brackets (also without a cover), hidden when it would give a result away
  const rec = (w, l, otl) => ({ gp: w + l + otl, w, l, otl, pts: 2 * w + otl });
  const upcoming = makeHome({ data: homeData({ featured: featured({ away_record: rec(3, 2, 1), home_record: rec(5, 0, 0) }) }) });
  await tick(420);
  const names = [...sec(upcoming, "hero").querySelectorAll(".v27HeroTeams > div")].map(text);
  assert.match(names[0], /Сиэтл Кракен\(3–2–1\)/);
  assert.match(names[2], /Филадельфия Флайерз\(5–0–0\)/);
  assert.equal(sec(upcoming, "hero").querySelector(".rec").getAttribute("title"), "победы – поражения – поражения в ОТ/Б");
  upcoming.box.spoilers = true;
  upcoming.window.dispatchEvent(new upcoming.window.Event("hoh-spoilers-change"));
  assert.ok(sec(upcoming, "hero").querySelector(".rec"), "a game that has not started: the record is no spoiler");
  upcoming.window.close();
  const finished = makeHome({ data: homeData({ featured: featured({ game_state: "OFF", away_score: 3, home_score: 2, away_record: rec(4, 2, 1), home_record: rec(5, 1, 0) }) }), spoilers: true });
  await tick(420);
  assert.ok(!sec(finished, "hero").querySelector(".rec"), "a finished game in no-spoilers mode: the record would show who won");
  finished.box.spoilers = false;
  finished.window.dispatchEvent(new finished.window.Event("hoh-spoilers-change"));
  assert.ok(sec(finished, "hero").querySelector(".rec"));
  finished.window.close();
  const bare = makeHome();
  await tick(420);
  assert.ok(!sec(bare, "hero").querySelector(".rec"), "no record in the data: nothing is drawn");
  bare.window.close();
}

{
  // goals of Russian players carry the number of the goal in the season, in the tile and in the player
  const items = [
    tile(21, 3, "Kirill Kaprizov", "Кирилл Капризов", "MIN", 2, "10:00", 1, 2, { russian: true, season_goal: 6 }),
    tile(22, 3, "Josh Doan", "Джош Доан", "BUF", 1, "05:58", 0, 1),
  ];
  const ctx = makeHome({ data: homeData({ goals: { ok: true, day: localDay(), live: false, total: 2, items } }) });
  await tick(420);
  const tiles = [...sec(ctx, "goals").querySelectorAll(".v27Goal")];
  assert.equal(text(tiles[0].querySelector(".nm")), "Капризов (6-я)", "the number of the goal in brackets");
  assert.equal(text(tiles[1].querySelector(".nm")), "Доан", "others have none");
  tiles[0].click();
  assert.match(text(ctx.document.getElementById("v27Ov")), /6-я шайба в сезоне/);
  ctx.window.close();
}

{
  // the default: the Russians are on, "my feed" waits in the settings
  const follows = [{ subject_type: "team", subject_key: "MIN", name: "Миннесота Уайлд" }];
  const ctx = makeHome({ follows, prefs: false, news: [{ news_id: 1, title: "Миннесота выиграла", published_at: iso(Date.now() - 60000), comment_count: 0 }, ...NEWS] });
  await tick(520);
  assert.ok(!sec(ctx, "russians").hidden, "the Russians block is on by default");
  assert.ok(!sec(ctx, "strip").querySelector(".v27Star, .v27Seg, .v27Hint"), "no stars, no switch, no hint");
  assert.ok(!sec(ctx, "goals").querySelector(".v27Mine"));
  assert.ok(!sec(ctx, "news").querySelector(".v27Mine"), "news in their usual order");
  assert.equal(sec(ctx, "news").querySelector(".v27News").dataset.v27News, "1");
  assert.equal(ctx.calls.filter((c) => c.url === "/api/telegram-center-v2/subscriptions").length, 0, "the follows are not even asked for");
  assert.equal(ctx.document.querySelectorAll(".v27Settings").length, 0, "the settings card lives on the Мои screen only");

  // the settings card
  ctx.document.querySelector('.tab[data-tab="follows"]').click();
  await tick(250);
  const card = ctx.document.querySelector("#view > .v27Settings");
  assert.ok(card, "the card is on the Мои screen");
  assert.equal(ctx.document.getElementById("v15Theme").nextElementSibling, card, "right under the theme switch");
  assert.match(text(card), /Главная страница/);
  assert.match(text(card), /Русские в НХЛ/);
  assert.match(text(card), /Моя лента/);
  const switches = [...card.querySelectorAll(".v27Sw")];
  assert.deepEqual(switches.map((b) => b.getAttribute("aria-checked")), ["true", "false"], "the Russians are on, my feed is off");
  assert.deepEqual(switches.map((b) => b.dataset.v27Pref), ["russians", "mine"]);
  switches[0].click();
  assert.equal(switches[0].getAttribute("aria-checked"), "false", "the Russians can be switched off");
  assert.ok(!switches[0].classList.contains("on"));
  assert.equal(ctx.window.localStorage.getItem("hoh-home-russians"), "0", "remembered");
  assert.equal(ctx.window.localStorage.getItem("hoh-home-mine-on"), null, "the other one is untouched");
  switches[1].click();
  assert.equal(ctx.window.localStorage.getItem("hoh-home-mine-on"), "1");
  switches[1].click();
  assert.equal(ctx.window.localStorage.getItem("hoh-home-mine-on"), "0", "and off again");
  switches[1].click();
  // the card goes away with the tab
  ctx.document.querySelector('.tab[data-tab="teams"]').click();
  await tick(250);
  assert.ok(!ctx.document.querySelector(".v27Settings"));

  // back on the home page: what was switched on is there
  ctx.document.querySelector('.tab[data-tab="games"]').click();
  await tick(700);
  assert.ok(sec(ctx, "russians").hidden, "the Russians block is off: the person switched it off");
  assert.ok(sec(ctx, "strip").querySelector(".v27Star"), "and the stars of my feed are on");
  assert.equal(sec(ctx, "news").querySelector(".v27News").dataset.v27News, "1");
  assert.ok(sec(ctx, "news").querySelector(".v27Mine"));
  assert.ok(ctx.calls.filter((c) => c.url === "/api/telegram-center-v2/subscriptions").length >= 1);
  ctx.window.close();

  // a person who changed nothing: the Russians and no stars; one who switched the Russians off: neither
  const only = makeHome({ follows, prefs: false });
  await tick(520);
  assert.ok(!sec(only, "russians").hidden);
  assert.ok(!sec(only, "strip").querySelector(".v27Star, .v27Seg, .v27Hint"));
  assert.equal(only.calls.filter((c) => c.url === "/api/telegram-center-v2/subscriptions").length, 0);
  only.window.close();
  const nothing = makeHome({ follows, prefs: false, stored: { "hoh-home-russians": "0" } });
  await tick(520);
  assert.ok(sec(nothing, "russians").hidden, "switched off in the settings: gone");
  nothing.window.close();
}

{
  // a game is "mine" for a reason, and the card says which one; a followed player brings his team along
  const subs = [{ subject_type: "player", subject_key: "1", name: "Кирилл Капризов", current_team_tri: "MIN" }];
  const ctx = makeHome({ follows: subs });
  await tick(520);
  const chips = [...sec(ctx, "strip").querySelectorAll(".v27Chip")];
  const mine = chips.filter((c) => c.classList.contains("mine"));
  assert.equal(mine.length, 1, "only the game of his team");
  assert.equal(mine[0].dataset.v27Game, "3", "VGK — MIN");
  assert.equal(text(mine[0].querySelector(".v27Why")), "★ Капризов", "the reason is on the card: a player I follow plays here");
  assert.ok(chips.filter((c) => !c.classList.contains("mine")).every((c) => !c.querySelector(".v27Why")), "other games say nothing");
  assert.equal(ctx.calls.filter((c) => c.url.startsWith("/api/telegram-center-v17/players/")).length, 0, "the team of the player came with the subscription: no extra questions");
  ctx.window.close();

  // a player who is not in the list of Russians: his team comes from the subscription alone
  const stranger = makeHome({ follows: [{ subject_type: "player", subject_key: "5555", name: "Иван Тестов", current_team_tri: "MIN" }] });
  await tick(520);
  assert.equal(text(sec(stranger, "strip").querySelector('.v27Chip[data-v27-game="3"] .v27Why')), "★ Тестов");
  assert.equal(stranger.calls.filter((c) => c.url.startsWith("/api/telegram-center-v17/players/")).length, 0);
  stranger.window.close();

  // a team I follow is named by its nickname; a team beats a player as the reason
  const both = makeHome({ follows: [...subs, { subject_type: "team", subject_key: "MIN", name: "Миннесота Уайлд" }, { subject_type: "team", subject_key: "NYR", name: "Нью-Йорк Рейнджерс" }] });
  await tick(520);
  assert.equal(text(sec(both, "strip").querySelector('.v27Chip[data-v27-game="3"] .v27Why')), "★ Уайлд");
  assert.equal(sec(both, "strip").querySelector('.v27Chip[data-v27-game="3"]').getAttribute("aria-label").includes("Уайлд"), true, "and it is read out by screen readers");
  both.window.close();

  // the game of a player with no known team: nothing starred while the team is unknown
  const lost = makeHome({ follows: [{ subject_type: "player", subject_key: "777", name: "Иван Иванов" }], lookups: {} });
  await tick(520);
  assert.ok(!sec(lost, "strip").querySelector(".v27Why"), "no team, no star");
  lost.window.close();
}

{
  // every game has its own link to watch; it does not open the match screen
  const ctx = makeHome();
  await tick(420);
  const boxes = [...sec(ctx, "strip").querySelectorAll(".v27ChipBox")];
  assert.equal(boxes.length, 3);
  const link = boxes[0].querySelector("a.v27Vk");
  assert.ok(link, "a VK link on the card");
  assert.equal(link.getAttribute("href"), "https://vkvideo.ru/video-1_1");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("aria-label"), /Запись в VK/, "a finished game: the recording");
  assert.ok(!boxes[0].querySelector("button a"), "the link is next to the button, not inside it");
  link.addEventListener("click", (e) => e.preventDefault());
  link.click();
  assert.equal(ctx.opened.length, 0, "a tap on VK does not open the match");
  ctx.window.close();

  const mixed = homeData({ games: [{ ...chip(1, "NYR", "TBL", "live", 1, 0, -1), vk_url: "https://vkvideo.ru/video-1_a" }, { ...chip(2, "COL", "DAL", "upcoming", null, null, 3), vk_url: "javascript:alert(1)" }, { ...chip(3, "FLA", "BUF", "final", 3, 5, -6), vk_url: null }] });
  const m = makeHome({ data: mixed });
  await tick(420);
  const mb = [...sec(m, "strip").querySelectorAll(".v27ChipBox")];
  assert.match(mb[0].querySelector("a.v27Vk").getAttribute("aria-label"), /Смотреть в VK/, "a game that is on: watch");
  assert.ok(!mb[1].querySelector("a"), "a link that is not a web link is never put on the page");
  assert.ok(!mb[2].querySelector("a"), "no link in the data: no badge");
  m.window.close();
}

{
  // Russians: who plays, how they played; the stat is hidden in no-spoilers mode; a tap opens the player
  const ctx = makeHome();
  await tick(420);
  const block = sec(ctx, "russians");
  assert.ok(!block.hidden);
  assert.equal(block.style.order, "2", "between the strip and the goals");
  assert.equal(text(block.querySelector(".v27Head b")), "Русские: как сыграли");
  assert.match(text(block.querySelector(".v27Head")), /голы \+ передачи/);
  const chips = [...block.querySelectorAll(".v27Ru")];
  assert.equal(chips.length, 3);
  assert.match(text(chips[0]), /Капризов/);
  assert.match(text(chips[0]), /2\+1/, "goals plus assists");
  assert.match(text(chips[0]), /MIN vs VGK/);
  assert.match(text(chips[1]), /27 из 29/, "a goalie: saves out of shots");
  assert.match(text(chips[2]), /\d\d:\d\d/, "a game ahead: the start time");
  assert.match(text(chips[2]), /SEA @ PHI/, "away games are marked with @");
  assert.equal(chips[0].querySelector("img").getAttribute("src"), "https://assets.test/1.png");
  chips[0].querySelector("img").dispatchEvent(new ctx.window.Event("error"));
  assert.ok(!chips[0].querySelector("img"), "a picture that does not load leaves the initial letter");
  assert.equal(text(chips[0].querySelector(".ph i")), "К");
  chips[1].click();
  assert.deepEqual(plain(ctx.players), [2], "a tap opens the player page");
  ctx.box.spoilers = true;
  ctx.window.dispatchEvent(new ctx.window.Event("hoh-spoilers-change"));
  const hidden = [...sec(ctx, "russians").querySelectorAll(".v27Ru")].map(text);
  assert.ok(!hidden.some((t) => /2\+1|27 из 29/.test(t)), "no spoilers: no stats");
  assert.ok(hidden[0].includes("•"));
  assert.ok(!/голы \+ передачи/.test(text(sec(ctx, "russians").querySelector(".v27Head"))));
  ctx.window.close();

  // titles by mood
  const titles = {};
  for (const [mode, day] of [["live", localDay()], ["schedule", localDay()], ["schedule", "2026-01-05"]]) {
    const c = makeHome({ data: homeData({ mode, russians: { ok: true, day, items: homeData().russians.items } }) });
    await tick(420);
    titles[`${mode}:${day === localDay() ? "today" : "other"}`] = text(sec(c, "russians").querySelector(".v27Head b"));
    c.window.close();
  }
  assert.deepEqual(titles, { "live:today": "Русские в игре", "schedule:today": "Русские сегодня", "schedule:other": "Русские · 5 янв" });
  // a live player has a red dot on the photo
  const liveRu = makeHome({ data: homeData({ mode: "live", russians: { ok: true, day: localDay(), items: [ru(1, "Кирилл Капризов", "MIN", "VGK", true, "live", { kind: "s", goals: 0, assists: 1, points: 1, toi: "10:00" })] } }) });
  await tick(420);
  assert.ok(sec(liveRu, "russians").querySelector(".v27Ru .ph em"));
  liveRu.window.close();
}

{
  // "my" part: follows turn on stars, the order of the strip, the "Мои" switch, goals and news about my teams
  const follows = [
    { subject_type: "team", subject_key: "MIN", name: "Миннесота Уайлд" },
    { subject_type: "team", subject_key: "NYR", name: "Нью-Йорк Рейнджерс" },
    { subject_type: "player", subject_key: "1", name: "Кирилл Капризов" },
    { subject_type: "player", subject_key: "9", name: "Артемий Панарин" },
    { subject_type: "player", subject_key: "5", name: "Андрей Свечников" },
    { subject_type: "group", subject_key: "RUS_NHL", name: "Все россияне в НХЛ" },
  ];
  const news = [
    { news_id: 401, title: "Обычная новость про другой клуб", body_text: null, published_at: iso(Date.now() - 10 * 60000), comment_count: 0 },
    { news_id: 402, title: "«Рейнджерс» проиграли дома, Панарин остался без очков", body_text: null, published_at: iso(Date.now() - 20 * 60000), comment_count: 0 },
    { news_id: 403, title: "Нью-Йорк Айлендерс подписали форварда", body_text: null, published_at: iso(Date.now() - 30 * 60000), comment_count: 0 },
    { news_id: 404, title: "Капризов набрал три очка, «Миннесота» победила", body_text: null, published_at: iso(Date.now() - 40 * 60000), comment_count: 0 },
    { news_id: 405, title: "Тренер Миннесоты объяснил выбор звена", body_text: null, published_at: iso(Date.now() - 50 * 60000), comment_count: 0 },
    { news_id: 406, title: "Ещё одна обычная новость", body_text: null, published_at: iso(Date.now() - 60 * 60000), comment_count: 0 },
  ];
  const games =[chip(1, "FLA", "BUF", "final", 3, 5, -10), chip(3, "VGK", "MIN", "final", 2, 4, -8), chip(7, "NYR", "TBL", "live", 1, 0, -1), chip(2, "OTT", "NJD", "final", 4, 1, -9, "OT")];
  const ctx = makeHome({ data: homeData({ mode: "live", games }), news, follows, lookups: { 9: "NYR" }, followsDelay: 120 });
  await tick(150);
  assert.ok(!sec(ctx, "strip").querySelector(".v27Star"), "the page is drawn at once, before the follows arrive");
  await tick(500);
  const strip = () => [...sec(ctx, "strip").querySelectorAll(".v27Chip")];
  assert.deepEqual(strip().map((c) => c.dataset.v27Game), ["7", "3", "1", "2"], "on now first (mine), then my games, then the rest in their order");
  assert.deepEqual(strip().map((c) => c.classList.contains("mine")), [true, true, false, false]);
  assert.ok(strip()[0].querySelector(".v27Star"), "a star on my game");
  assert.ok(!strip()[2].querySelector(".v27Star"));
  assert.ok(sec(ctx, "strip").querySelector(".v27Seg"), "the switch is there");
  assert.ok(!sec(ctx, "strip").querySelector(".v27Head > [data-v27-all]"), "it takes the place of 'Все матчи' in the header (the strip still ends with it)");
  assert.ok(sec(ctx, "strip").querySelector(".v27ChipMore"));
  assert.ok(!sec(ctx, "strip").querySelector(".v27Hint"), "a person who follows does not get the hint");
  assert.equal(ctx.calls.filter((c) => c.url === "/api/telegram-center-v17/players/9").length, 1, "the team of a followed player who is not in the list is asked once");
  assert.equal(ctx.calls.filter((c) => c.url === "/api/telegram-center-v17/players/1").length, 0, "a Russian of the list needs no lookup");

  // the switch
  sec(ctx, "strip").querySelector('[data-v27-seg="mine"]').click();
  assert.deepEqual(strip().map((c) => c.dataset.v27Game), ["7", "3"], "only my games");
  assert.ok(sec(ctx, "strip").querySelector('[data-v27-seg="mine"]').classList.contains("on"));
  assert.equal(ctx.window.localStorage.getItem("hoh-home-mine"), "1", "the choice is remembered");
  sec(ctx, "strip").querySelector('[data-v27-seg="all"]').click();
  assert.equal(strip().length, 4);
  assert.equal(ctx.window.localStorage.getItem("hoh-home-mine"), "0");

  // goals of my teams and players
  const own = sec(ctx, "goals").querySelectorAll(".v27Goal");
  assert.ok(own[0].querySelector(".v27Mine"), "a goal of MIN has a star");
  assert.ok(!own[1].querySelector(".v27Mine"), "a goal of VGK has none");
  // Russians: the followed one first, with a star
  const rus = [...sec(ctx, "russians").querySelectorAll(".v27Ru")];
  assert.ok(rus[0].classList.contains("mine"));
  assert.match(text(rus[0]), /★ Капризов/);
  assert.deepEqual(rus.map((r) => r.dataset.v27Ru), ["1", "5", "2"], "the followed ones first (in their own order), then the rest");
  // news: about my teams first, with a mark; "Нью-Йорк" alone is not enough
  const rows = [...sec(ctx, "news").querySelectorAll(".v27News")];
  assert.deepEqual(rows.map((r) => r.dataset.v27News), ["402", "404", "405"], "news about my teams first: a nickname, a surname and another form of a city are found; the newest news only fills the gaps");
  assert.ok(rows.every((r) => r.querySelector(".v27Mine")));
  assert.match(text(rows[0].querySelector(".v27Mine")), /ваша команда/);
  // the news page marks them too; "Нью-Йорк" alone (the Islanders) is not enough
  rows[2].click();
  await tick(60);
  const cards = [...ctx.document.querySelectorAll(".v27NCard")];
  assert.deepEqual(cards.filter((c) => c.querySelector(".v27Mine")).map((c) => c.dataset.v27Open), ["402", "404"]);
  assert.ok(!cards.find((c) => c.dataset.v27Open === "403").querySelector(".v27Mine"));
  ctx.window.close();

  // a restart inside five minutes does not ask for the follows again
  const again = makeHome({ news, follows, lookups: { 9: "NYR" } });
  await tick(520);
  const asked = () => again.calls.filter((c) => c.url === "/api/telegram-center-v2/subscriptions").length;
  assert.equal(asked(), 1);
  await again.S.refresh();
  await again.S.refresh();
  assert.equal(asked(), 1, "the follows are kept for a few minutes");
  again.window.close();
}

{
  // a person who follows nobody gets a hint, once; outside Telegram nothing personal appears
  const nobody = makeHome({ follows: [] });
  await tick(520);
  const hint = sec(nobody, "strip").querySelector(".v27Hint");
  assert.ok(hint, "an invitation to choose teams");
  assert.ok(!sec(nobody, "strip").querySelector(".v27Seg"), "no switch without games of mine");
  assert.ok(sec(nobody, "strip").querySelector(".v27Head > [data-v27-all]"));
  let teamsTab = 0;
  nobody.document.querySelector('.tab[data-tab="teams"]').addEventListener("click", () => { teamsTab += 1; });
  hint.querySelector("[data-v27-follow]").click();
  assert.equal(teamsTab, 1, "the invitation leads to the Teams tab");
  nobody.window.close();
  const closing = makeHome({ follows: [] });
  await tick(520);
  sec(closing, "strip").querySelector("[data-v27-hint-close]").click();
  assert.ok(!sec(closing, "strip").querySelector(".v27Hint"), "closed");
  assert.equal(closing.window.localStorage.getItem("hoh-home-hint"), "1", "and it stays closed");
  closing.window.close();

  const outside = makeHome({ follows: null });
  await tick(520);
  assert.ok(!sec(outside, "strip").querySelector(".v27Hint, .v27Seg, .v27Star"), "not signed in: the page is the same for everybody");
  assert.ok(!sec(outside, "goals").querySelector(".v27Mine"));
  assert.ok(!sec(outside, "news").querySelector(".v27Mine"));
  assert.equal(sec(outside, "news").querySelectorAll(".v27News").length, 3);
  assert.ok(outside.window.HOHV27.owns(), "a failed follows request does not take the page down");
  outside.window.close();

  // the choice of an earlier visit is read at the start: "Мои" is already on
  const remembered = makeHome({ follows: [{ subject_type: "team", subject_key: "BUF", name: "Баффало Сэйбрз" }], stored: { "hoh-home-mine": "1", "hoh-home-hint": "1" } });
  await tick(520);
  assert.deepEqual([...sec(remembered, "strip").querySelectorAll(".v27Chip")].map((c) => c.dataset.v27Game), ["1"], "only Buffalo's game");
  remembered.window.close();
  // the follows say "mine only" but none of my teams plays today: all games are shown, no empty strip
  const idle = makeHome({ follows: [{ subject_type: "team", subject_key: "SJS", name: "Сан-Хосе Шаркс" }], stored: { "hoh-home-mine": "1" } });
  await tick(520);
  assert.equal(sec(idle, "strip").querySelectorAll(".v27Chip").length, 3);
  assert.ok(!sec(idle, "strip").querySelector(".v27Seg"));
  idle.window.close();
}

console.log("home v27 validation passed");
