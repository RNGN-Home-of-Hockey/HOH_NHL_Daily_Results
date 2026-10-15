// Broadcast cards after the commentators' feedback of 2026-10-05…11: the period is always named on the card, Winline's
// live 3-way of regulation time is read, the live queue gets situation cards (score after the period, «обе забьют»,
// power play), a forgotten card leaves the air by itself, and the operator has his own «УБРАТЬ С ЭКРАНА».
import assert from "node:assert/strict";
import { broadcastMarketText } from "../cloudflare-worker/src/broadcast-market-text.js";
import { canonicalBroadcastWinlineMarket, handleBroadcastRequest, ON_AIR_MAX_SECONDS } from "../cloudflare-worker/src/broadcast-dashboard-v2.js";
import { powerPlayState } from "../cloudflare-worker/src/live-betting-engine.js";
import { buildSituationCards, mergeLiveInsightCards } from "../cloudflare-worker/src/live-context-engine.js";
import { loadSpecialTeams, specialTeamsFromSummary } from "../cloudflare-worker/src/nhl-special-teams.js";

// ---- 1) the market line on the card names the period -----------------------------------------------------------------
const text = (m) => broadcastMarketText(m);
assert.equal(text({ type: "game_total", period: "P1", side: "over", line: 1.5 }), "1-Й ПЕРИОД · ТОТАЛ БОЛЬШЕ 1,5");
assert.equal(text({ type: "game_total", period: "GAME", side: "under", line: 5.5 }), "ОБЩИЙ ТОТАЛ МЕНЬШЕ 5,5");
assert.equal(text({ type: "game_total", side: "over", line: 6 }), "ОБЩИЙ ТОТАЛ БОЛЬШЕ 6");
assert.equal(text({ type: "team_total", period: "P2", side: "over", line: 0.5 }), "2-Й ПЕРИОД · ТОТАЛ КОМАНДЫ БОЛЬШЕ 0,5 ГОЛА");
assert.equal(text({ type: "handicap", period: "P1", line: -1 }), "1-Й ПЕРИОД · ФОРА -1 ГОЛ");
assert.equal(text({ type: "handicap", period: "GAME", line: 1.5 }), "ФОРА +1,5 ГОЛА");
assert.equal(text({ type: "moneyline", period: "GAME", side: "COL" }), "ПОБЕДА");
assert.equal(text({ type: "moneyline", period: "REG", side: "COL" }), "ПОБЕДА В ОСНОВНОЕ ВРЕМЯ");
assert.equal(text({ type: "moneyline", period: "REG", side: "draw" }), "НИЧЬЯ В ОСНОВНОЕ ВРЕМЯ");
assert.equal(text({ type: "period_3_result", side: "DAL" }), "3-Й ПЕРИОД · ПОБЕДА");
assert.equal(text({ type: "period_1_result", side: "draw" }), "1-Й ПЕРИОД · НИЧЬЯ");
assert.equal(text({ type: "double_chance", period: "REG", side: "team_or_draw" }), "НЕ ПРОИГРАЕТ В ОСНОВНОЕ ВРЕМЯ");
assert.equal(text({ type: "both_teams_score", side: "yes" }), "ОБЕ КОМАНДЫ ЗАБЬЮТ");
assert.equal(text({ type: "next_goal_team", side: "DAL" }), "СЛЕДУЮЩИЙ ГОЛ");
assert.equal(text({ type: "player_points", side: "over", line: 0.5 }), null, "unknown market: the caller keeps its fallback");

// ---- 2) Winline's live markets ---------------------------------------------------------------------------------------
const event = { winline_event_id: "16925556", updated_at: "2026-10-15 01:20:25", deeplink: null };
const game = { game_pk: 2026020107, away_tri: "DAL", home_tri: "COL" };
const teams = { team1: "COL", team2: "DAL" };
const row = (market_type, freetext, outcome_name, subject_key, odds, value) => ({ winline_market_id: `${market_type}:${outcome_name}`, market_type, subject_key, outcome_name, odds, is_live: 1, raw_json: JSON.stringify({ freetext, value }), updated_at: "2026-10-15 01:20:25" });
const reg = canonicalBroadcastWinlineMarket(row("matchresultexcludingovertime", "Match Result (Excluding Overtime)", "Home", "COL", 2.4), event, game, teams);
assert.deepEqual([reg.market_type, reg.period, reg.subject, reg.side, reg.line], ["moneyline", "REG", "COL", "COL", null], "the live 3-way of regulation time");
const draw = canonicalBroadcastWinlineMarket(row("matchresultexcludingovertime", "Match Result (Excluding Overtime)", "Draw", null, 4.1), event, game, teams);
assert.deepEqual([draw.market_type, draw.period, draw.subject, draw.side], ["moneyline", "REG", null, "draw"]);
const p1 = canonicalBroadcastWinlineMarket(row("1periodtotal:1.5", "1 Period Total", "over", null, 2.05, "1.5"), event, game, teams);
assert.deepEqual([p1.market_type, p1.period, p1.side, p1.line], ["game_total", "P1", "over", 1.5]);
assert.equal(broadcastMarketText({ type: p1.market_type, period: p1.period, side: p1.side, line: p1.line }), "1-Й ПЕРИОД · ТОТАЛ БОЛЬШЕ 1,5");

// ---- 3) the power play on the ice ------------------------------------------------------------------------------------
const plays = [
  { typeDescKey: "faceoff", periodDescriptor: { number: 1, periodType: "REG" }, timeInPeriod: "07:00", situationCode: "1551" },
  { typeDescKey: "penalty", periodDescriptor: { number: 1, periodType: "REG" }, timeInPeriod: "07:24", situationCode: "1551" },
  { typeDescKey: "faceoff", periodDescriptor: { number: 1, periodType: "REG" }, timeInPeriod: "07:24", situationCode: "1451" },
  { typeDescKey: "shot-on-goal", periodDescriptor: { number: 1, periodType: "REG" }, timeInPeriod: "07:35", situationCode: "1451" },
];
const liveGame = { game_pk: 2026020107, season_id: "20262027", game_state: "LIVE", away_tri: "DAL", home_tri: "COL", away_score: 0, home_score: 0, period_number: 1, seconds_remaining: 1200 - (7 * 60 + 54), in_intermission: false };
assert.deepEqual(powerPlayState(liveGame, plays), { team: "COL", opponent: "DAL", skaters: "5x4", running_seconds: 30, situation_code: "1451" });
assert.equal(powerPlayState({ ...liveGame, seconds_remaining: 1200 - (9 * 60 + 40) }, plays), null, "after 115 s the code is not trusted");
assert.equal(powerPlayState({ ...liveGame, in_intermission: true }, plays), null);
assert.equal(powerPlayState(liveGame, [...plays, { ...plays[3], timeInPeriod: "07:50", situationCode: "0651" }]), null, "an empty net is not a power play");

// ---- 4) the situation cards ------------------------------------------------------------------------------------------
const NOW = Date.parse("2026-10-15T02:30:00Z");
const fresh = { provider: "winline", status: "open", is_live: true, updated_at: new Date(NOW - 30_000).toISOString(), event_id: "e" };
const mk = (market_type, period, subject, side, odds, line = null) => ({ ...fresh, market_id: `${market_type}:${period}:${subject}:${side}`, selection_id: `${market_type}:${period}:${subject}:${side}`, market_type, period, subject, side, line, odds });
const gameRow = (i, p, reg, win) => ({ game_pk: 500 + i, scheduled_start_utc: new Date(Date.parse("2025-10-20T00:00:00Z") + i * 86400000 * 9).toISOString(), final_win: win, regulation_goals_for: reg[0], regulation_goals_against: reg[1], final_goals_for: reg[0] + (win && reg[0] === reg[1] ? 1 : 0), final_goals_against: reg[1] + (!win && reg[0] === reg[1] ? 1 : 0), p1_goals_for: p[0][0], p1_goals_against: p[0][1], p2_goals_for: p[1][0], p2_goals_against: p[1][1], p3_goals_for: p[2][0], p3_goals_against: p[2][1] });
// DAL trailed by one after two periods in 10 games: 3 won in regulation, 3 went to overtime (lost), 4 lost in regulation
// (the league after two periods at −1: 24% wins, 40% without a regulation loss)
const dalLong = [
  ...[0, 1, 2].map((i) => gameRow(i, [[0, 1], [0, 0], [2, 0]], [2, 1], 1)),
  ...[3, 4, 5].map((i) => gameRow(i, [[0, 1], [0, 0], [1, 0]], [1, 1], 0)),
  ...[6, 7, 8, 9].map((i) => gameRow(i, [[0, 1], [0, 0], [0, 1]], [0, 2], 0)),
  ...[10, 11, 12].map((i) => gameRow(i, [[2, 0], [1, 0], [0, 0]], [3, 0], 1)),
  { ...gameRow(13, [[0, 1], [0, 0], [3, 0]], [3, 1], 1), regulation_goals_for: 4 }, // period goals do not add up: never counted
];
const situation = {
  game: { ...liveGame, period_number: 3, seconds_remaining: 15 * 60, away_score: 1, home_score: 2 },
  live_context: { periods: [{ period: 1, goals_by_team: { DAL: 1, COL: 1 } }, { period: 2, goals_by_team: { DAL: 0, COL: 1 } }, { period: 3, goals_by_team: {} }] },
};
const markets = [mk("double_chance", "REG", "DAL", "team_or_draw", 2.4), mk("moneyline", "GAME", "DAL", "DAL", 3.8), mk("moneyline", "GAME", "COL", "COL", 1.28)];
let cards = buildSituationCards(situation, markets, { recent: { DAL: dalLong.slice(0, 12), COL: [] }, long: { DAL: dalLong, COL: [] } }, { now: NOW });
assert.equal(cards.length, 1);
assert.equal(cards[0].broadcast_title, "УСТУПАЯ ШАЙБУ ПОСЛЕ ДВУХ ПЕРИОДОВ, DAL НЕ ПРОИГРАЛ В ОСНОВНОЕ ВРЕМЯ В 6 ИЗ 10 МАТЧЕЙ", "3 of 10 wins are below the bar, 6 of 10 without a regulation loss are not");
assert.deepEqual([cards[0].live_origin, cards[0].market.type, cards[0].market.period, cards[0].market.subject, cards[0].market.odds], ["score_state_history", "double_chance", "REG", "DAL", 2.4]);
assert.deepEqual(cards[0].evidence.situation, { after_period: 2, score_diff: -1 });
assert.equal(cards[0].evidence.game_pks.length, 10);
assert.match(cards[0].broadcast_subtitle, /10 таких матчей DAL с октября 2025/);
// a goal in the 3rd period: the score after two periods is no longer the score on the ice
cards = buildSituationCards({ ...situation, game: { ...situation.game, away_score: 2 }, live_context: { periods: [situation.live_context.periods[0], situation.live_context.periods[1], { period: 3, goals_by_team: { DAL: 1 } }] } }, markets, { long: { DAL: dalLong } }, { now: NOW });
assert.equal(cards.length, 0);
// late in the period the story waits for the intermission
assert.equal(buildSituationCards({ ...situation, game: { ...situation.game, seconds_remaining: 300 } }, markets, { long: { DAL: dalLong } }, { now: NOW }).length, 0);
// a stale line is never priced
assert.equal(buildSituationCards(situation, markets.map((m) => ({ ...m, updated_at: new Date(NOW - 5 * 60_000).toISOString() })), { long: { DAL: dalLong } }, { now: NOW }).length, 0);
// an average comeback record is no story: 5 of 10 without a regulation loss is about the league's 40%
assert.equal(buildSituationCards(situation, markets, { long: { DAL: [...dalLong.slice(0, 5), gameRow(5, [[0, 1], [0, 0], [0, 1]], [0, 2], 0), ...dalLong.slice(6)] } }, { now: NOW }).length, 0);

// «обе забьют»: DAL has not scored yet and has scored in 22 games in a row (teams score in ~95% of games: a short run is no story)
const scoredIn = (n, blankAt) => Array.from({ length: n }, (_, i) => gameRow(i, i === blankAt ? [[0, 1], [0, 0], [0, 0]] : [[1, 0], [0, 1], [1, 1]], i === blankAt ? [0, 1] : [2, 2], i === blankAt ? 0 : 1));
const scoring = scoredIn(30, 22);
const conceding = Array.from({ length: 10 }, (_, i) => ({ ...gameRow(i, [[0, 1], [1, 0], [1, 0]], i === 0 ? [2, 0] : [2, 1], 1) }));
const bttsSnap = { ...situation, game: { ...situation.game, period_number: 2, seconds_remaining: 600, away_score: 0, home_score: 2 } };
const btts = [mk("both_teams_score", "GAME", null, "yes", 1.72)];
cards = buildSituationCards(bttsSnap, btts, { recent: { DAL: scoring.slice(0, 12), COL: conceding }, long: { DAL: scoring, COL: conceding } }, { now: NOW });
assert.equal(cards.length, 1);
assert.equal(cards[0].broadcast_title, "DAL ЗАБИВАЕТ В 22 МАТЧАХ ПОДРЯД");
assert.equal(buildSituationCards(bttsSnap, btts, { recent: { DAL: scoredIn(12, 9), COL: conceding }, long: { DAL: scoredIn(40, 9), COL: conceding } }, { now: NOW }).length, 0, "9 games in a row is ordinary");
assert.equal(buildSituationCards(bttsSnap, btts, { recent: { DAL: scoredIn(12, -1), COL: conceding }, long: { DAL: scoredIn(21, -1), COL: conceding } }, { now: NOW })[0].broadcast_title, "DAL ЗАБИВАЛ ВО ВСЕХ 21 МАТЧЕ С ОКТЯБРЯ 2025", "no blank game in the stored history: since when, not «подряд»");
assert.equal(cards[0].evidence.team, "DAL", "the card is painted in the colours of the team that has not scored");
assert.match(cards[0].broadcast_subtitle, /COL пропускал в 9 из 10/);

// the power play: COL on the ice 5 on 4, 31% in the season
const special = { COL: { gp: 7, pp: 0.31, pk: 0.8, pp_rank: 3, pk_rank: 10 }, DAL: { gp: 7, pp: 0.15, pk: 0.74, pp_rank: 25, pk_rank: 28 } };
const ppSnap = { game: liveGame, live_context: { periods: [], power_play: { team: "COL", opponent: "DAL", skaters: "5x4", running_seconds: 30 } } };
cards = buildSituationCards(ppSnap, [mk("next_goal_team", "GAME", "COL", "COL", 1.62), mk("next_goal_team", "GAME", "DAL", "DAL", 2.9)], { special }, { now: NOW });
assert.equal(cards.length, 1);
assert.equal(cards[0].broadcast_title, "COL В БОЛЬШИНСТВЕ: 31% РЕАЛИЗАЦИИ — 3-Е МЕСТО В НХЛ");
assert.match(cards[0].broadcast_subtitle, /^DAL в меньшинстве: 74% \(28-е место\)/);
assert.equal(cards[0].eyebrow, "LIVE · БОЛЬШИНСТВО 5 НА 4");
assert.ok(cards[0].air_score >= 80, "a power play goes to the top of the queue");
assert.equal(broadcastMarketText(cards[0].market), "СЛЕДУЮЩИЙ ГОЛ");
// a weak power play against a good penalty kill is no story
assert.equal(buildSituationCards(ppSnap, [mk("next_goal_team", "GAME", "COL", "COL", 1.62)], { special: { ...special, COL: { ...special.COL, pp: 0.12, pp_rank: 30 }, DAL: { ...special.DAL, pk: 0.86 } } }, { now: NOW }).length, 0);
// one power-play card in the merged queue, above the shot pressure on the same market
const shot = { ...cards[0], id: "shot", live_origin: "shot_support", air_score: 66, score: 66 };
const merged = mergeLiveInsightCards([cards[0], { ...cards[0], id: "pp2", market: { ...cards[0].market, market_id: "other" } }], [shot]);
assert.deepEqual(merged.map((c) => c.live_origin), ["power_play"]);

// ---- 5) the season numbers of the NHL --------------------------------------------------------------------------------
const triById = new Map([[21, "COL"], [25, "DAL"], [1, "NJD"]]);
const st = specialTeamsFromSummary([{ teamId: 21, gamesPlayed: 7, powerPlayPct: 0.31, penaltyKillPct: 0.8 }, { teamId: 25, gamesPlayed: 7, powerPlayPct: 0.15, penaltyKillPct: 0.74 }, { teamId: 1, gamesPlayed: 6, powerPlayPct: 0.238, penaltyKillPct: 0.705 }, { teamId: 99, gamesPlayed: 3, powerPlayPct: 0.5, penaltyKillPct: 1 }], triById);
assert.deepEqual(Object.keys(st).sort(), ["COL", "DAL", "NJD"]);
assert.deepEqual([st.COL.pp_rank, st.NJD.pp_rank, st.DAL.pp_rank, st.COL.pk_rank, st.DAL.pk_rank, st.NJD.pk_rank], [1, 2, 3, 1, 2, 3]);
{
  const meta = new Map();
  let fetches = 0;
  const db = {
    prepare: (sql) => ({
      all: async () => ({ results: [...Array(32).keys()].map((i) => ({ tri_code: `T${String(i).padStart(2, "0")}`, nhl_team_id: i + 1 })) }),
      bind: (...args) => ({
        first: async () => (meta.has(args[0]) ? { meta_value: meta.get(args[0]) } : null),
        run: async () => { if (/INSERT INTO data_core_meta/.test(sql)) meta.set(args[0], args[1]); return { meta: { changes: 1 } }; },
      }),
    }),
  };
  const fetchImpl = async (url) => {
    fetches++;
    assert.match(String(url), /seasonId%3D20262027/);
    return new Response(JSON.stringify({ data: [...Array(32).keys()].map((i) => ({ teamId: i + 1, gamesPlayed: 7, powerPlayPct: i / 100, penaltyKillPct: 0.8 })) }), { status: 200 });
  };
  const first = await loadSpecialTeams(db, { seasonId: "20262027", fetchImpl, nowMs: NOW });
  assert.equal(Object.keys(first).length, 32);
  assert.equal(first.T31.pp_rank, 1);
  await loadSpecialTeams(db, { seasonId: "20262027", fetchImpl, nowMs: NOW + 3600_000 });
  assert.equal(fetches, 1, "kept for 6 hours");
  await loadSpecialTeams(db, { seasonId: "20262027", fetchImpl: async () => { fetches++; throw new Error("down"); }, nowMs: NOW + 7 * 3600_000 });
  assert.equal(fetches, 2);
  assert.equal((await loadSpecialTeams(db, { seasonId: "20262027", fetchImpl: async () => { throw new Error("down"); }, nowMs: NOW + 7 * 3600_000 })).T31.pp_rank, 1, "the NHL is down: the saved numbers are used");
}

// ---- 6) a forgotten card leaves the air by itself --------------------------------------------------------------------
assert.equal(ON_AIR_MAX_SECONDS, 180);
for (const [seconds, expired] of [[40, false], [ON_AIR_MAX_SECONDS + 5, true]]) {
  const writes = [];
  const shown = { card_id: "insight-1", game_pk: 2026020107, headline_ru: "ФАКТ", stat_text_ru: "ПОБЕДА", shown_at: "2026-10-15 02:00:00", status: "shown", on_air_seconds: seconds, render_hash: "h" };
  const db = {
    prepare: (sql) => {
      const api = {
        first: async () => (/FROM broadcast_cards bc/.test(sql) ? shown : null),
        run: async () => { writes.push(sql.replace(/\s+/g, " ").trim()); return { meta: { changes: 1 } }; },
      };
      return { ...api, bind: () => api };
    },
  };
  const res = await handleBroadcastRequest(new Request("https://x.test/api/broadcast/state?game=2026020107"), { DB: db }, "/api/broadcast/state");
  const body = await res.json();
  assert.equal(body.on_air_max_seconds, ON_AIR_MAX_SECONDS);
  if (expired) {
    assert.equal(body.on_air, null, "the overlay hides it");
    assert.match(writes[0], /^UPDATE broadcast_cards SET status='hidden'/);
    assert.match(writes[1], /INSERT INTO broadcast_operator_actions.*'hidden','auto'/, "«Эфирная лента» shows who took it off");
  } else {
    assert.equal(body.on_air.card_id, "insight-1");
    assert.equal(writes.length, 0);
  }
}

// ---- 7) the operator's page ------------------------------------------------------------------------------------------
{
  const html = await (await handleBroadcastRequest(new Request("https://x.test/broadcast"), {}, "/broadcast")).text();
  assert.match(html, /<button class="airoff" id="air-off" type="button" hidden>УБРАТЬ С ЭКРАНА<\/button>/);
  assert.match(html, /@media\(max-width:760px\)\{\.air\.live\{position:fixed/, "on a phone the ON AIR bar stays at the bottom of the screen");
  const js = await (await handleBroadcastRequest(new Request("https://x.test/broadcast/app.js"), {}, "/broadcast/app.js")).text();
  new Function(js);
  assert.match(js, /const ON_AIR_MAX_SECONDS=180;/);
  assert.match(js, /function broadcastMarketText\(market\)/);
  assert.match(js, /setInterval\(refreshAir,5000\)/);
  assert.doesNotMatch(js, /\\\\d/, "no doubled backslashes in the portal's regular expressions");
}

console.log("broadcast live situations validation passed");
