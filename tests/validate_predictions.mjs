// The game of the fans (v29): "Кто победит?" with the Winline odds on every game, points and levels, the table of the best fans,
// the settlement of the finished games and the morning message of the bot. The API runs on a real SQLite with the tables of the
// real migrations; the screen runs in jsdom.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import {
  LEVELS, levelOf, nhlDateOf, isOpen, settleGame, sidePoints, periodRange, seasonOf, fanLabel, fanCode, digestText, localParts, formatXp,
} from "../cloudflare-worker/src/telegram-center-v29-predictions-data.js";
import { handleTelegramCenterV29, runFanPredictionSettlement, runFanPredictionDigest, SCRIPT_PATH } from "../cloudflare-worker/src/telegram-center-v29-predictions.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const plain = (v) => JSON.parse(JSON.stringify(v));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- 1) the rules ----------------------------------------------------------------------------------------------------------------
{
  // ten levels with numbers; the gaps grow (the owner: «второй уровень быстро, третий подольше, и так далее»)
  assert.deepEqual(LEVELS.map((l) => [l.name, l.min]), [["Уровень 1", 0], ["Уровень 2", 20], ["Уровень 3", 60], ["Уровень 4", 120], ["Уровень 5", 220], ["Уровень 6", 380], ["Уровень 7", 620], ["Уровень 8", 1000], ["Уровень 9", 1600], ["Уровень 10", 2500]]);
  const gaps = LEVELS.slice(1).map((l, i) => l.min - LEVELS[i].min);
  assert.ok(gaps.every((g, i) => i === 0 || g > gaps[i - 1]), `every next level takes longer: ${gaps.join(", ")}`);
  assert.ok(LEVELS[1].min <= 2 * 11, "level 2 comes with the first right picks (a right winner gives 11 XP)");
  const l0 = levelOf(0);
  assert.deepEqual([l0.name, l0.n, l0.to_next, l0.next.name, l0.next.n], ["Уровень 1", 1, 20, "Уровень 2", 2]);
  const l400 = levelOf(400);
  assert.equal(l400.name, "Уровень 6", "400 XP: level 6");
  assert.equal(l400.note, "Знаток");
  assert.equal(l400.to_next, 220);
  assert.equal(Math.round(l400.progress * 1000), 83);
  const top = levelOf(3700);
  assert.equal(top.name, "Уровень 10");
  assert.equal(top.note, "Легенда");
  assert.equal(top.next, null);
  assert.equal(top.progress, 1);
  assert.equal(levelOf(-5).xp, 0);
  assert.equal(levelOf("abc").name, "Уровень 1");

  assert.equal(nhlDateOf("2026-10-13T23:15:00Z"), "2026-10-13", "an evening game in America belongs to its day");
  assert.equal(nhlDateOf("2026-10-14T02:30:00Z"), "2026-10-13", "a late western game too");
  assert.equal(nhlDateOf("bad"), null);

  const now = Date.parse("2026-10-13T20:00:00Z");
  assert.equal(isOpen({ game_state: "FUT", scheduled_start_utc: "2026-10-13T23:00:00Z" }, now), true);
  assert.equal(isOpen({ game_state: "PRE", scheduled_start_utc: "2026-10-13T20:05:00Z" }, now), true);
  assert.equal(isOpen({ game_state: "FUT", scheduled_start_utc: "2026-10-13T19:59:00Z" }, now), false, "the scheduled start has passed: closed");
  assert.equal(isOpen({ game_state: "LIVE", scheduled_start_utc: "2026-10-13T23:00:00Z" }, now), false, "the NHL says it is on: closed");

  // points: +1 for a pick, +10 for the winner, +10 for an underdog by the odds at the start, +5 against the majority
  assert.deepEqual(plain(sidePoints({ won: false, pickOdds: 3, otherOdds: 1.4, pickVotes: 1, totalVotes: 20 })), { vote: 1, correct: 0, underdog: 0, minority: 0, total: 1 });
  assert.equal(sidePoints({ won: true, pickOdds: 1.62, otherOdds: 2.3, pickVotes: 9, totalVotes: 10 }).total, 11, "a favourite that won: 11");
  assert.equal(sidePoints({ won: true, pickOdds: 2.3, otherOdds: 1.62, pickVotes: 5, totalVotes: 10 }).total, 21, "an underdog that won: 21");
  assert.equal(sidePoints({ won: true, pickOdds: 2.05, otherOdds: 1.8, pickVotes: 5, totalVotes: 10 }).underdog, 0, "a near coin flip is no underdog (under 2.10)");
  assert.equal(sidePoints({ won: true, pickOdds: 1.95, otherOdds: 1.88, pickVotes: 2, totalVotes: 12 }).minority, 5, "under 30% of 12 votes: against the majority");
  assert.equal(sidePoints({ won: true, pickOdds: null, otherOdds: null, pickVotes: 1, totalVotes: 5 }).total, 11, "few votes, no odds: no bonus");
  assert.equal(sidePoints({ won: true, pickOdds: 2.3, otherOdds: 1.62, pickVotes: 2, totalVotes: 12 }).total, 26, "everything at once: 26");

  const s = settleGame({ state: "OFF", homeScore: 2, awayScore: 3, homeOdds: 1.62, awayOdds: 2.3, homeVotes: 10, awayVotes: 2 });
  assert.equal(s.winner, "away");
  assert.equal(s.away.total, 26);
  assert.equal(s.home.total, 1);
  assert.equal(settleGame({ state: "FINAL", homeScore: 4, awayScore: 1 }).winner, "home", "FINAL counts too");
  assert.equal(settleGame({ state: "LIVE", homeScore: 4, awayScore: 1 }), null, "not over: nothing yet");
  assert.equal(settleGame({ state: "OFF", homeScore: 2, awayScore: 2 }), null, "a tie is not a final hockey score");
  const voided = settleGame({ state: "PPD" });
  assert.equal(voided.winner, "void", "postponed: no points");
  assert.equal(voided.home.total + voided.away.total, 0);

  assert.deepEqual(plain(periodRange("week", "2026-10-13")), { from: "2026-10-12", to: "2026-10-18" }, "a week from Monday to Sunday");
  assert.deepEqual(plain(periodRange("week", "2026-10-18")), { from: "2026-10-12", to: "2026-10-18" }, "Sunday is the end of the same week");
  assert.deepEqual(plain(periodRange("month", "2026-02-10")), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(plain(periodRange("season", "2026-10-13")), { season: "20262027" });
  assert.equal(seasonOf("2027-04-20"), "20262027", "the spring belongs to the season that started in the autumn");
  assert.equal(periodRange("year", "2026-10-13"), null);

  assert.equal(fanLabel(5, "kaprizov97"), "@kaprizov97");
  assert.equal(fanLabel(5, "@nick"), "@nick");
  assert.match(fanLabel(5, null), /^Болельщик \d{4}$/, "no nickname: a number, not the name from Telegram");
  assert.equal(fanCode(123456), fanCode(123456), "the number is stable");
  assert.notEqual(fanCode(123456), fanCode(123457));
  assert.equal(formatXp(3700), "3 700");

  const msg = digestText([
    { away_tri: "TBL", home_tri: "NYR", pick_tri: "TBL", result: "win", xp: 26 },
    { away_tri: "NJD", home_tri: "DET", pick_tri: "NJD", result: "loss", xp: 1 },
    { away_tri: "BOS", home_tri: "SJS", pick_tri: "BOS", result: "void", xp: 0 },
  ], { levelXp: 427 });
  assert.match(msg, /^🏒 Итоги ваших прогнозов/);
  assert.match(msg, /✅ TBL — NYR: вы выбрали TBL · \+26 XP/);
  assert.match(msg, /❌ NJD — DET: вы выбрали NJD · \+1 XP/);
  assert.ok(!/BOS/.test(msg), "a game that was not played is not in the message");
  assert.match(msg, /Угадано 1 из 2 · \+27 XP/);
  assert.match(msg, /\nУровень 6 — 427 XP, до уровня 7: 193 XP$/);
  assert.equal(digestText([{ result: "void", xp: 0 }]), null, "nothing played: no message");
  assert.ok(!/TBL|XP/.test(digestText([{ away_tri: "TBL", home_tri: "NYR", pick_tri: "TBL", result: "win", xp: 26 }], { noSpoilers: true })), "no-spoilers: no results in the message");
  assert.deepEqual(plain(localParts(Date.parse("2026-10-13T07:30:00Z"), "Europe/Moscow")), { date: "2026-10-13", hour: 10 });
  assert.equal(localParts(Date.parse("2026-10-13T07:30:00Z"), "Not/AZone").hour, 10, "an unknown time zone falls back to Moscow");
}

// ---- the database: the tables of the real migrations on SQLite ----------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migration(file));
  assert.ok(m, `${table} in ${file}`);
  return m[0];
};
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const t of ["teams", "games", "telegram_users", "notification_log", "winline_events", "winline_markets"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
  raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
  raw.exec(createOf("0018_winline_market_snapshots.sql", "winline_market_snapshots"));
  raw.exec(createOf("0028_user_profiles_and_exact_player_news.sql", "app_user_profiles"));
  raw.exec(migration("0029_user_profile_username_norm.sql").split(";")[0] + ";");
  raw.exec(migration("0030_user_profile_no_spoilers.sql").split(";")[0] + ";");
  raw.exec(migration("0043_notification_user_preferences.sql"));
  raw.exec(migration("0048_fan_predictions.sql"));
  raw.exec(migration("0050_fan_prediction_scores.sql"));
  const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: raw.prepare(sql).all(...args.map(norm)).map((x) => ({ ...x })) }),
    first: async () => { const x = raw.prepare(sql).get(...args.map(norm)); return x ? { ...x } : null; },
    run: async () => { const r = raw.prepare(sql).run(...args.map(norm)); return { meta: { changes: Number(r.changes) }, changes: Number(r.changes) }; },
  });
  return {
    raw,
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      raw.exec("BEGIN");
      try { const out = []; for (const s of list) out.push(await s.run()); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}

const TOKEN = "123456:TEST-TOKEN";
const NOW = Date.parse("2026-10-13T20:00:00Z"); // 23:00 in Moscow; the NHL day of 13 October
function initDataFor(user, { token = TOKEN, at = NOW } = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(at / 1000)), query_id: "AAE", user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
const A = { id: 101, first_name: "Иван", username: "ivan" };
const B = { id: 102, first_name: "Пётр" };

const db = makeDb();
const env = { DB: db, TELEGRAM_CENTER_BOT_TOKEN: TOKEN };
{
  const r = db.raw;
  for (const [tri, ru] of [["TBL", "Тампа-Бэй Лайтнинг"], ["NYR", "Нью-Йорк Рейнджерс"], ["NJD", "Нью-Джерси Девилз"], ["DET", "Детройт Ред Уингз"], ["BOS", "Бостон Брюинз"], ["SJS", "Сан-Хосе Шаркс"], ["MIN", "Миннесота Уайлд"], ["VGK", "Вегас Голден Найтс"]]) {
    r.prepare("INSERT INTO teams(tri_code,name_en,name_ru,logo_url) VALUES(?,?,?,?)").run(tri, tri, ru, `https://l.test/${tri}.svg`);
  }
  const game = r.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,period_type) VALUES(?,?,?,?,?,?,?,?,?,?)");
  game.run(9001, "20262027", 2, "2026-10-13T23:00:00Z", "FUT", "DET", "NJD", 0, 0, null);
  game.run(9002, "20262027", 2, "2026-10-13T23:15:00Z", "FUT", "NYR", "TBL", 0, 0, null);
  game.run(9003, "20262027", 1, "2026-10-13T23:30:00Z", "FUT", "VGK", "MIN", 0, 0, null); // preseason: not in the game
  game.run(9004, "20262027", 2, "2026-10-13T19:00:00Z", "LIVE", "SJS", "BOS", 1, 0, "REG"); // already on
  game.run(9005, "20262027", 2, "2026-10-14T23:00:00Z", "FUT", "MIN", "VGK", 0, 0, null); // tomorrow
  game.run(9010, "20262027", 2, "2026-10-12T23:00:00Z", "OFF", "NYR", "TBL", 2, 3, "REG"); // played: TBL won
  game.run(9011, "20262027", 2, "2026-10-12T23:30:00Z", "PPD", "DET", "NJD", 0, 0, null); // postponed
  game.run(9012, "20262027", 2, "2026-10-11T23:00:00Z", "FINAL", "MIN", "VGK", 4, 1, "REG"); // played last Sunday: MIN won
  const ev = r.prepare("INSERT INTO winline_events(winline_event_id,game_pk,status,starts_at) VALUES(?,?,?,?)");
  const mk = r.prepare("INSERT INTO winline_markets(winline_market_id,winline_event_id,market_type,subject_type,subject_key,outcome_name,odds,is_live,active,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  ev.run("E1", 9001, "prematch", "2026-10-14T02:00:00+03:00");
  mk.run("E1:moneyline:1", "E1", "moneyline", "team", "DET", "Home", 1.92, 0, 1, "2026-10-13 12:40:34");
  mk.run("E1:moneyline:2", "E1", "moneyline", "team", "NJD", "Away", 1.88, 0, 1, "2026-10-13 12:40:34");
  mk.run("E1:main_1x2:1", "E1", "main_1x2_regular", "team", "DET", "1", 2.5, 0, 1, "2026-10-13 12:40:34");
  ev.run("E2", 9002, "prematch", "2026-10-14T02:15:00+03:00");
  mk.run("E2:moneyline:1", "E2", "moneyline", "team", "NYR", "Home", 2.3, 0, 1, "2026-10-13 12:40:34");
  mk.run("E2:moneyline:2", "E2", "moneyline", "team", "TBL", "Away", 1.62, 0, 1, "2026-10-13 12:40:34");
  mk.run("E2:moneyline:live", "E2", "moneyline", "team", "TBL", "Away", 9.9, 1, 1, "2026-10-13 12:50:00"); // a live line never counts
  ev.run("E10", 9010, "prematch", "2026-10-13T02:00:00+03:00");
  const snap = r.prepare("INSERT INTO winline_market_snapshots(game_pk,winline_event_id,winline_market_id,market_type,subject_type,subject_key,outcome_name,odds,is_live,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  snap.run(9010, "E10", "E10:moneyline:1", "moneyline", "team", "NYR", "Home", 1.7, 0, "2026-10-12T10:00:00.000Z");
  snap.run(9010, "E10", "E10:moneyline:2", "moneyline", "team", "TBL", "Away", 2.1, 0, "2026-10-12T10:00:00.000Z");
  snap.run(9010, "E10", "E10:moneyline:1", "moneyline", "team", "NYR", "Home", 1.62, 0, "2026-10-12T22:00:00.000Z"); // the last line before the start
  snap.run(9010, "E10", "E10:moneyline:2", "moneyline", "team", "TBL", "Away", 2.3, 0, "2026-10-12T22:00:00.000Z");
  snap.run(9010, "E10", "E10:moneyline:2", "moneyline", "team", "TBL", "Away", 7.5, 0, "2026-10-12T23:40:00.000Z"); // after the start: ignored
}

const realNow = Date.now;
Date.now = () => NOW;
const call = async (path, { method = "GET", user = null, body, initData } = {}) => {
  const headers = {};
  if (user) headers["X-Telegram-Init-Data"] = initDataFor(user);
  if (initData) headers["X-Telegram-Init-Data"] = initData;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const res = await handleTelegramCenterV29(request, env, path.split("?")[0]); // the router passes the path without the query
  return { status: res.status, body: await res.json() };
};
const API = "/api/telegram-center-v29";

// ---- 2) the votes ----------------------------------------------------------------------------------------------------------------
{
  const guest = await call(`${API}/slate`);
  assert.equal(guest.status, 200);
  assert.equal(guest.body.date, "2026-10-13", "the next game day with an open vote");
  assert.equal(guest.body.signed_in, false);
  assert.deepEqual(guest.body.games.map((g) => g.game_pk), [9004, 9001, 9002], "all the regular games of that day, by time; no preseason, no tomorrow");
  const [live, njd, tbl] = guest.body.games;
  assert.equal(live.open, false, "a game that is on is closed");
  assert.equal(njd.open, true);
  assert.deepEqual(tbl.odds, { home: 2.3, away: 1.62 }, "the Winline odds of the winner including overtime, before any vote; the live line is not used");
  assert.deepEqual(njd.odds, { home: 1.92, away: 1.88 }, "not the 1X2 of the regular time");
  assert.deepEqual(tbl.votes, { total: 0, home: null, away: null }, "the split of the fans is not shown before one's own pick");
  assert.equal(tbl.my, null);
  assert.equal(tbl.away.tri, "TBL");
  assert.equal(tbl.home.name_ru, "Нью-Йорк Рейнджерс");
  assert.equal(tbl.away.logo, "https://l.test/TBL.svg");
  assert.equal(guest.body.last, null);

  assert.equal((await call(`${API}/predictions`, { method: "POST", body: { game_pk: 9002, pick: "away" } })).status, 401, "a guest cannot vote");
  const forged = await call(`${API}/predictions`, { method: "POST", body: { game_pk: 9002, pick: "away" }, initData: initDataFor(A, { token: "999:OTHER" }) });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error, "telegram_signature_invalid", "a forged Telegram signature is refused");
  const old = await call(`${API}/predictions`, { method: "POST", body: { game_pk: 9002, pick: "away" }, initData: initDataFor(A, { at: NOW - 3 * 86400000 }) });
  assert.equal(old.body.error, "telegram_init_data_expired");

  const first = await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 9002, pick: "away" } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.game.my, { pick: "away", result: null, xp: null, score: null, exact: null });
  assert.deepEqual(first.body.game.votes, { total: 1, home: 0, away: 1 }, "after the pick the split is shown");
  let row = db.raw.prepare("SELECT * FROM fan_predictions WHERE telegram_user_id=101 AND game_pk=9002").get();
  assert.equal(row.pick_tri, "TBL");
  assert.equal(row.odds_at_pick, 1.62, "the odds the person saw are kept");
  assert.equal(row.game_date, "2026-10-13");
  assert.equal(row.season_id, "20262027");
  assert.ok(db.raw.prepare("SELECT 1 FROM telegram_users WHERE telegram_user_id=101").get(), "the person is known to the bot");

  const changed = await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 9002, pick: "home" } });
  assert.equal(changed.body.game.my.pick, "home", "the pick can be changed before the start");
  row = db.raw.prepare("SELECT COUNT(*) n, MAX(odds_at_pick) o, MAX(pick_tri) t FROM fan_predictions WHERE telegram_user_id=101 AND game_pk=9002").get();
  assert.deepEqual([row.n, row.o, row.t], [1, 2.3, "NYR"], "still one pick per person and game");
  await call(`${API}/predictions`, { method: "POST", user: B, body: { game_pk: 9002, pick: "away" } });

  const closed = await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 9004, pick: "home" } });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, "voting_closed", "a game that is on cannot be voted");
  assert.equal((await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 9003, pick: "home" } })).body.error, "game_not_in_the_game", "no preseason");
  assert.equal((await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 99999, pick: "home" } })).status, 404);
  assert.equal((await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 9001, pick: "draw" } })).body.error, "invalid_pick", "no draw: the winner including overtime");
  assert.equal((await call(`${API}/predictions`, { method: "POST", user: A, body: "{nope" })).body.error, "invalid_json");
  Date.now = () => Date.parse("2026-10-13T23:15:00Z");
  assert.equal((await call(`${API}/predictions`, { method: "POST", user: A, body: { game_pk: 9002, pick: "away" } })).body.error, "voting_closed", "closed at the scheduled start even if the NHL still says FUT");
  Date.now = () => NOW;

  const mine = await call(`${API}/slate`, { user: A });
  assert.equal(mine.body.signed_in, true);
  const g2 = mine.body.games.find((g) => g.game_pk === 9002);
  assert.deepEqual(g2.votes, { total: 2, home: 1, away: 1 });
  assert.equal(g2.my.pick, "home");
  assert.deepEqual(mine.body.games.find((g) => g.game_pk === 9001).votes, { total: 0, home: null, away: null }, "a game I did not vote still hides the split");
  assert.deepEqual(mine.body.games.find((g) => g.game_pk === 9004).votes, { total: 0, home: 0, away: 0 }, "a closed game shows it to everybody");

  const some = await call(`${API}/games?ids=9002,9001,abc,9003`);
  assert.deepEqual(some.body.games.map((g) => g.game_pk), [9001, 9002], "the chosen games, without the preseason one");
  assert.equal((await call(`${API}/games?ids=`)).status, 400);
  assert.equal((await call(`${API}/predictions`)).status, 405);
  assert.equal((await call(`${API}/nothing`)).status, 404);
  assert.equal((await handleTelegramCenterV29(new Request("https://x.test/api/other"), env, "/api/other")), null, "other paths are not taken");
}

// ---- 3) the settlement of the finished games --------------------------------------------------------------------------------------
{
  const pick = db.raw.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,game_date,season_id) VALUES(?,?,?,?,?,?)");
  const user = db.raw.prepare("INSERT OR IGNORE INTO telegram_users(telegram_user_id,first_name) VALUES(?,?)");
  for (let id = 101; id <= 112; id++) user.run(id, `U${id}`);
  // 9010: TBL (away) won 3:2; two fans picked TBL, ten picked NYR -> TBL: 1 + 10 + 10 (2.30 at the start) + 5 (17% of 12) = 26
  pick.run(101, 9010, "away", "TBL", "2026-10-12", "20262027");
  pick.run(102, 9010, "away", "TBL", "2026-10-12", "20262027");
  for (let id = 103; id <= 112; id++) pick.run(id, 9010, "home", "NYR", "2026-10-12", "20262027");
  pick.run(101, 9011, "home", "DET", "2026-10-12", "20262027");
  pick.run(103, 9011, "away", "NJD", "2026-10-12", "20262027");
  pick.run(101, 9012, "home", "MIN", "2026-10-11", "20262027");

  const s = await runFanPredictionSettlement(env, { now: Date.parse("2026-10-13T05:00:00Z") });
  assert.equal(s.games, 3, "the finished and the postponed games are settled; the open ones wait");
  assert.equal(s.void_games, 1);
  const got = (uid, pk) => db.raw.prepare("SELECT result,xp,settled_at FROM fan_predictions WHERE telegram_user_id=? AND game_pk=?").get(uid, pk);
  assert.deepEqual([got(101, 9010).result, got(101, 9010).xp], ["win", 26], "the underdog against the majority: 26");
  assert.equal(got(102, 9010).xp, 26);
  assert.deepEqual([got(103, 9010).result, got(103, 9010).xp], ["loss", 1], "a wrong pick still brings 1");
  assert.deepEqual([got(101, 9011).result, got(101, 9011).xp], ["void", 0], "postponed: no points");
  assert.deepEqual([got(101, 9012).result, got(101, 9012).xp], ["win", 11], "no odds, one vote: 11");
  assert.equal(got(101, 9002).settled_at, null, "the game of tonight is not touched");
  const fg = db.raw.prepare("SELECT * FROM fan_prediction_games WHERE game_pk=9010").get();
  assert.deepEqual([fg.winner, fg.home_votes, fg.away_votes, fg.home_odds, fg.away_odds, fg.home_xp, fg.away_xp], ["away", 10, 2, 1.62, 2.3, 1, 26], "the odds at the start, not the one after it");
  const again = await runFanPredictionSettlement(env, { now: Date.parse("2026-10-13T05:05:00Z") });
  assert.equal(again.games, 0, "nothing is settled twice");
  // a pick that appears later for a settled game (a repair of the data): only it is settled, the others keep their time
  pick.run(104, 9012, "away", "VGK", "2026-10-11", "20262027");
  const before = got(101, 9012).settled_at;
  await runFanPredictionSettlement(env, { now: Date.parse("2026-10-13T05:10:00Z") });
  assert.equal(got(101, 9012).settled_at, before, "a settled pick is never touched again");
  assert.deepEqual([got(104, 9012).result, got(104, 9012).xp], ["loss", 1]);

  const settled = await call(`${API}/games?ids=9010`, { user: A });
  const g = settled.body.games[0];
  assert.equal(g.open, false);
  assert.deepEqual(g.my, { pick: "away", result: "win", xp: 26, score: null, exact: false });
  assert.equal(g.settled.winner, "away");
  assert.deepEqual(g.settled.score, { home: 2, away: 3, period_type: "REG" });
  assert.deepEqual(g.odds, { home: 1.62, away: 2.3 }, "a settled game shows the odds at the start");
}

// ---- 4) me and the table -----------------------------------------------------------------------------------------------------------
{
  db.raw.prepare("INSERT INTO app_user_profiles(telegram_user_id,display_username,avatar_base64,avatar_mime) VALUES(101,'kaprizov97','AAAA','image/webp')").run();
  const me = await call(`${API}/me`, { user: A });
  assert.equal(me.status, 200);
  assert.equal(me.body.label, "@kaprizov97");
  assert.equal(me.body.has_nick, true);
  assert.equal(me.body.level.name, "Уровень 2", "26 + 11 = 37 XP");
  assert.equal(me.body.level.xp, 37);
  assert.equal(me.body.level.to_next, 23);
  assert.deepEqual(me.body.stats, { total: 4, settled: 2, correct: 2, pending: 1, accuracy: 100 }, "the postponed game is neither right nor wrong");
  assert.deepEqual(plain(me.body.ranks.week), { rank: 1, players: 12, xp: 26, correct: 1, total: 1 }, "the week from Monday 12 October: only the game of the 12th");
  assert.equal(me.body.ranks.month.xp, 37);
  assert.equal(me.body.ranks.season.rank, 1);
  assert.deepEqual(me.body.recent.map((x) => x.game_pk), [9010, 9012], "the last settled picks, newest first");
  assert.equal(me.body.prefs.morning_digest, true, "the morning message is on by default");
  assert.equal((await call(`${API}/me`)).status, 401);

  const meB = await call(`${API}/me`, { user: B });
  assert.match(meB.body.label, /^Болельщик \d{4}$/);
  assert.equal(meB.body.has_nick, false);
  assert.equal(meB.body.ranks.week.rank, 2, "the same points: the earlier person first");

  assert.equal((await call(`${API}/me`, { method: "PUT", user: A, body: { morning_digest: "no" } })).status, 400);
  assert.equal((await call(`${API}/me`, { method: "PUT", user: A, body: { morning_digest: false } })).body.prefs.morning_digest, false);
  assert.equal((await call(`${API}/me`, { user: A })).body.prefs.morning_digest, false);
  await call(`${API}/me`, { method: "PUT", user: A, body: { morning_digest: true } });

  const store = new Map();
  globalThis.caches = { default: { match: async (req) => store.get(req.url)?.clone(), put: async (req, res) => { store.set(req.url, res); } } };
  const week = await call(`${API}/leaderboard?period=week`);
  assert.equal(week.status, 200);
  assert.equal(week.body.from, "2026-10-12");
  assert.equal(week.body.to, "2026-10-18");
  assert.equal(week.body.players, 12);
  assert.deepEqual(week.body.rows.slice(0, 3).map((r) => [r.rank, r.label.startsWith("@") ? r.label : "Болельщик", r.xp]), [[1, "@kaprizov97", 26], [2, "Болельщик", 26], [3, "Болельщик", 1]]);
  assert.equal(week.body.rows[0].avatar_url, "/api/telegram-center-v22/avatars/101", "an avatar only for a person who has one");
  assert.equal(week.body.rows[1].avatar_url, null);
  assert.equal(week.body.rows[0].level, "Уровень 2");
  assert.ok(week.body.rows.every((r) => !("id" in r) && !("telegram_user_id" in r)), "no Telegram ids in the public table");
  assert.equal(week.body.me, null, "a guest has no place");
  const month = await call(`${API}/leaderboard?period=month`, { user: B });
  assert.equal(month.body.rows[0].xp, 37, "the month counts the game of Sunday too");
  assert.equal(month.body.me.rank, 2);
  assert.equal((await call(`${API}/leaderboard?period=year`)).status, 400);
  // the table is kept a minute: a new point is seen after that
  db.raw.prepare("UPDATE fan_predictions SET xp=xp+100 WHERE telegram_user_id=112 AND game_pk=9010").run();
  assert.equal((await call(`${API}/leaderboard?period=week`)).body.rows[0].label, "@kaprizov97", "within the minute the same table");
  store.clear();
  assert.equal((await call(`${API}/leaderboard?period=week`)).body.rows[0].xp, 101, "then the new one");
  db.raw.prepare("UPDATE fan_predictions SET xp=xp-100 WHERE telegram_user_id=112 AND game_pk=9010").run();
  store.clear();
  delete globalThis.caches;

  const status = await call(`${API}/status`);
  assert.equal(status.body.settled_games, 3);
  assert.equal(status.body.players, 12);
}

// ---- 5) the morning message of the bot ---------------------------------------------------------------------------------------------
{
  db.raw.prepare("INSERT INTO app_user_profiles(telegram_user_id,display_username,no_spoilers) VALUES(102,NULL,1)").run();
  db.raw.prepare("INSERT INTO fan_profiles(telegram_user_id,morning_digest) VALUES(103,0)").run();
  db.raw.prepare("UPDATE telegram_users SET notifications_enabled=0 WHERE telegram_user_id=104").run();
  db.raw.prepare("INSERT INTO notification_user_preferences(telegram_user_id,timezone_name) VALUES(105,'Asia/Vladivostok')").run();

  const early = await runFanPredictionDigest(env, { now: Date.parse("2026-10-13T05:00:00Z"), dryRun: true });
  assert.equal(early.due, 0, "08:00 in Moscow: too early");
  const dryCalls = [];
  const dry = await runFanPredictionDigest(env, { now: Date.parse("2026-10-13T07:30:00Z"), dryRun: true, send: async (...a) => { dryCalls.push(a); } });
  assert.equal(dryCalls.length, 0, "a dry run sends nothing");
  assert.equal(dry.sent, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM notification_log").get().n, 0, "and reserves nothing");
  const msgA = dry.messages.find((m) => m.user_id === 101);
  assert.match(msgA.text, /✅ TBL — NYR: вы выбрали TBL · \+26 XP/);
  assert.match(msgA.text, /✅ VGK — MIN: вы выбрали MIN · \+11 XP/);
  assert.ok(!/DET/.test(msgA.text), "the postponed game is not in it");
  assert.match(msgA.text, /Угадано 2 из 2 · \+37 XP\nУровень 2 — 37 XP, до уровня 3: 23 XP$/);
  assert.match(dry.messages.find((m) => m.user_id === 102).text, /режим без спойлеров/, "no results for a person in no-spoilers mode");
  assert.ok(!dry.messages.some((m) => [103, 104, 105].includes(m.user_id)), "switched off, no bot messages at all, or not 10:00 yet in Vladivostok");
  assert.equal(dry.skipped_off, 2);
  assert.equal(dry.skipped_hour, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM fan_predictions WHERE reported_at IS NOT NULL").get().n, 0, "a dry run changes nothing");

  const sent = [];
  const send = async (token, chatId, textValue, markup) => {
    if (chatId === 107) throw new Error("Forbidden: bot was blocked by the user");
    if (chatId === 108) throw new Error("Too Many Requests: retry after 5");
    sent.push({ token, chatId, text: textValue, markup });
  };
  const first = await runFanPredictionDigest(env, { now: Date.parse("2026-10-13T07:30:00Z"), send, budget: 3 });
  assert.deepEqual(sent.map((x) => x.chatId), [101, 102, 106], "in the order of the ids, up to the budget of the run");
  assert.equal(sent[0].token, TOKEN);
  assert.equal(sent[0].markup.inline_keyboard[0][0].text, "Прогнозы на сегодня");
  assert.match(sent[0].markup.inline_keyboard[0][0].web_app.url, /\/telegram-app-v24$/, "the button opens the app");
  assert.equal(first.deferred_budget, 6, "the rest waits for the next run (five minutes later)");
  assert.equal(first.failed, 0);
  const reported = (uid) => db.raw.prepare("SELECT COUNT(*) n FROM fan_predictions WHERE telegram_user_id=? AND reported_at IS NOT NULL").get(uid).n;
  assert.equal(reported(101), 3, "every settled pick of the message is marked, the postponed one too");
  assert.equal(reported(103), 2, "switched off: marked without a message, nothing piles up");
  assert.equal(reported(104), 2, "no bot messages: the same (both of its picks)");
  assert.equal(reported(105), 0, "Vladivostok: later");
  assert.ok(db.raw.prepare("SELECT 1 FROM notification_log WHERE telegram_user_id=101 AND notification_key='fan:morning:2026-10-13' AND notification_type='fan_morning_digest'").get());

  sent.length = 0;
  const second = await runFanPredictionDigest(env, { now: Date.parse("2026-10-13T07:35:00Z"), send, budget: 25 });
  assert.deepEqual(sent.map((x) => x.chatId), [109, 110, 111, 112], "the next run sends the rest; nobody gets a second message");
  assert.equal(second.failed, 2);
  assert.equal(reported(107), 1, "the bot is blocked: not tried again tomorrow");
  assert.equal(reported(108), 0, "a temporary error: tried again");
  assert.ok(!db.raw.prepare("SELECT 1 FROM notification_log WHERE telegram_user_id=108").get(), "and its reservation is released");
  // a pick settled later the same morning waits for the next day: one message a day
  db.raw.prepare("UPDATE fan_predictions SET settled_at='2026-10-13T08:00:00.000Z',result='loss',xp=1 WHERE telegram_user_id=101 AND game_pk=9002").run();
  sent.length = 0;
  const later = await runFanPredictionDigest(env, { now: Date.parse("2026-10-13T08:00:00Z"), send });
  assert.ok(!sent.some((x) => x.chatId === 101), "already told today");
  assert.ok(later.skipped_duplicate >= 1);
  assert.equal((await runFanPredictionDigest({ DB: db }, { now: NOW })).error, "missing_telegram_center_token", "no token: no real sending");
}

// ---- 6) the routes of the app --------------------------------------------------------------------------------------------------------
const script = await (await handleTelegramCenterV29(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).text();
{
  assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
  assert.equal((await handleTelegramCenterV29(new Request(`https://x.test${SCRIPT_PATH}`, { method: "POST" }), env, SCRIPT_PATH)).status, 405);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v29-predict.js?build=29.0"), "the script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v29-predict.js") > shell.indexOf("/telegram-app/v28-backdrop.js"), "after the backdrop");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).status, 200, "reachable through the main router");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${API}/slate`), {}, `${API}/slate`)).status, 503, "the API too (no database here)");
  const entry = fs.readFileSync(new URL("../cloudflare-worker/src/worker-entry.js", import.meta.url), "utf8");
  assert.match(entry, /await runPostgameFinalizer\(env\);[\s\S]{0,300}await runFanPredictionSettlement\(env\);/, "the points are counted right after the games are finalized");
  assert.match(entry, /if \(envFlag\(env\.FAN_PREDICTIONS_DIGEST_ENABLED, false\)\) \{\s*try \{\s*await runFanPredictionDigest\(env\);/, "the morning message has its own switch");
  assert.match(fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /"FAN_PREDICTIONS_DIGEST_ENABLED": "1"/);
}
Date.now = realNow;

// ---- 7) the screen -------------------------------------------------------------------------------------------------------------------
const START = (h) => new Date(Date.now() + h * 3600000).toISOString();
const team = (tri) => ({ tri, name_ru: tri, logo: `https://l.test/${tri}.svg` });
const block = (pk, away, home, extra = {}) => ({ game_pk: pk, date: "2026-10-13", start: START(2), state: "FUT", open: true, away: team(away), home: team(home), odds: { home: 2.3, away: 1.62 }, votes: { total: 7, home: null, away: null }, my: null, settled: null, ...extra });

const HOME_HTML = `<section class="v27Home"><div class="v27Sec" data-sec="hero"><article class="v27Hero" data-game="9002"><div class="v29Slot" data-v29-game="9002"></div></article></div></section>`;
const card = (pk, title) => `<article class="v19Broadcast" data-v19-game="${pk}"><div class="v19Thumb"></div><div class="v19BroadcastText"><b>${title}</b><div class="v19CardOdds"></div></div></article>`;
const MATCHES_HTML = `<div class="v19Archive"><section class="v19Cal"></section><div class="v19DateTitle"><b>13 октября</b></div><div class="v19BroadcastList">${card(9004, "BOS — SJS")}${card(9001, "NJD — DET")}${card(9002, "TBL — NYR")}${card(9010, "TBL — NYR")}${card(9011, "MIN — VGK")}</div></div>`;

function makeApp({ tab = "games", games = null, signedIn = true, postError = null, spoilers = false, html = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html class="v15Light"><head></head><body><nav id="tabs"><button class="tab${tab === "games" ? " active" : ""}" data-tab="games"></button><button class="tab${tab === "broadcasts" ? " active" : ""}" data-tab="broadcasts"></button><button class="tab${tab === "follows" ? " active" : ""}" data-tab="follows"></button></nav><main id="view">${html ?? HOME_HTML}</main></body></html>`, { url: "https://x.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const box = {
    tab, calls: [], alerts: [], opened: [],
    games: games || [
      block(9004, "BOS", "SJS", { open: false, state: "LIVE", votes: { total: 3, home: 2, away: 1 } }),
      block(9001, "NJD", "DET", { odds: { home: 1.92, away: 1.88 } }),
      block(9002, "TBL", "NYR"),
      block(9010, "TBL", "NYR", { open: false, state: "OFF", votes: { total: 0, home: 0, away: 0 }, settled: { winner: "away", home_xp: 1, away_xp: 21, score: { home: 2, away: 3 } } }),
      block(9011, "MIN", "VGK", { open: false, state: "OFF", votes: { total: 12, home: 3, away: 9 }, settled: { winner: "home", home_xp: 26, away_xp: 1, score: { home: 4, away: 1 } } }),
    ],
  };
  if (signedIn) window.Telegram = { WebApp: { initData: "query_id=AAE&hash=x" } };
  window.alert = (m) => box.alerts.push(m);
  window.scrollTo = () => {};
  window.HOHNoSpoilers = () => spoilers;
  const ME = { ok: true, label: "@kaprizov97", has_nick: true, level: { key: "l2", n: 2, name: "Уровень 2", note: "Первая победа", min: 20, xp: 37, next: { key: "l3", n: 3, name: "Уровень 3", min: 60 }, to_next: 23, progress: 0.42 }, stats: { total: 4, settled: 2, correct: 2, pending: 1, accuracy: 100 }, ranks: { week: { rank: 1, players: 12, xp: 26, correct: 1, total: 1 } }, recent: [], prefs: { morning_digest: true } };
  const BOARD = (period) => ({ ok: true, period, players: 12, rows: Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, label: i === 0 ? "@kaprizov97" : `Болельщик ${1000 + i}`, avatar_url: i === 0 ? "/api/telegram-center-v22/avatars/101" : null, xp: period === "month" ? 100 - i : 50 - i, correct: 1, total: 2, level: "Уровень 2" })), me: signedIn ? { rank: 1, players: 12, xp: 26, correct: 1, total: 1 } : null });
  window.HOHV15 = {
    esc,
    state: { profile: false },
    currentTab: () => box.tab,
    tabsVisible: () => true,
    view: () => window.document.getElementById("view"),
    runCore: () => {},
    openGameV19: (pk, opts) => box.opened.push([pk, opts]),
    api: async (url, opt = {}) => {
      box.calls.push({ url, method: opt.method || "GET", body: opt.body ? JSON.parse(opt.body) : null });
      if (url.startsWith(`${API}/slate`)) return { ok: true, date: "2026-10-13", signed_in: signedIn, games: box.games.filter((g) => g.open || g.state === "LIVE").map((g) => ({ ...g })), last: signedIn ? { date: "2026-10-12", total: 2, correct: 1, xp: 27 } : null };
      if (url.startsWith(`${API}/games`)) {
        const ids = new URL(`https://x.test${url}`).searchParams.get("ids").split(",").map(Number);
        return { ok: true, games: box.games.filter((g) => ids.includes(g.game_pk)).map((g) => ({ ...g })) };
      }
      if (url === `${API}/predictions` && opt.method === "POST") {
        if (postError) throw new Error(postError);
        const b = JSON.parse(opt.body);
        const g = box.games.find((x) => x.game_pk === b.game_pk);
        const updated = { ...g, my: { pick: b.pick, result: null, xp: null, score: b.score || null, exact: null }, votes: { total: 8, home: b.pick === "home" ? 2 : 1, away: b.pick === "away" ? 7 : 6 } };
        box.games = box.games.map((x) => (x.game_pk === b.game_pk ? updated : x));
        return { ok: true, game: updated };
      }
      if (url === `${API}/me` && opt.method === "PUT") return { ok: true, prefs: JSON.parse(opt.body) };
      if (url === `${API}/me`) {
        if (!signedIn) throw new Error("missing_telegram_init_data");
        return ME;
      }
      if (url.startsWith(`${API}/leaderboard`)) return BOARD(new URL(`https://x.test${url}`).searchParams.get("period"));
      throw new Error(`unexpected ${url}`);
    },
  };
  window.eval(script);
  return { window, document: window.document, box, S: window.HOHV29 };
}

{
  // the match of the day: the question between the two buttons, no odds on them (the Winline block under them is the only one)
  const ctx = makeApp();
  const { document } = ctx;
  let heroClicks = 0;
  document.querySelector(".v27Hero").addEventListener("click", () => { heroClicks += 1; });
  await tick(250);
  const hero = document.querySelector(".v29Slot");
  const row = hero.querySelector(".v29Row3");
  assert.ok(row, "one row: button, question, button");
  assert.deepEqual([...row.children].map((x) => x.className.split(" ")[0]), ["v29Btn", "v29Mid", "v29Btn"]);
  assert.equal(text(row.querySelector(".v29Mid")), "Ктопобедит?", "the question in the middle (the owner), on two lines");
  assert.deepEqual([...hero.querySelectorAll(".v29Btn b")].map(text), ["TBL", "NYR"], "the guests on the left, the hosts on the right, as the teams above");
  assert.ok(!/1\.62|2\.30|кэф/i.test(text(hero)), "no odds on the buttons (the owner: «уберём кэфы на исход с учётом буллитов»)");
  assert.equal(text(hero.querySelector(".v29Line")), "Проголосовали: 7 · с учётом ОТ и буллитов");
  assert.ok(!document.querySelector(".v29MatchesHead") && !document.querySelector("[data-sec='predict']"), "no list of the night on the home page any more");

  // a vote from the match of the day: the card under it does not open the match
  hero.querySelector('[data-v29-pick="away"]').click();
  assert.equal(heroClicks, 0, "the tap is the vote, not 'open the match'");
  assert.ok(hero.querySelector('[data-v29-pick="away"]').classList.contains("mine"), "the pick is shown at once");
  assert.match(text(hero.querySelector(".v29Line")), /Сохраняем…/);
  await tick(30);
  const post = ctx.box.calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { game_pk: 9002, pick: "away" });
  assert.deepEqual([...hero.querySelectorAll(".v29Btn .v29Pc")].map(text), ["88%", "13%"], "after the vote: the split of the fans");
  assert.ok([...hero.querySelectorAll(".v29Btn")].every((b) => b.querySelector(".v29Nm .v29Pc")), "the share sits under the name");
  assert.match(text(hero.querySelector(".v29Line")), /^Ваш выбор: TBL · можно поменять до \d\d:\d\d$/);
  hero.querySelector('[data-v29-pick="away"]').click();
  await tick(10);
  assert.equal(ctx.box.calls.filter((c) => c.method === "POST").length, 1, "the same pick again sends nothing");
  ctx.window.close();
}

{
  // the tab "Матчи": the vote in the cards of the day, how the fans voted in the cards of the games that are over
  const ctx = makeApp({ tab: "broadcasts", html: MATCHES_HTML });
  const { document } = ctx;
  const opened = [];
  document.querySelectorAll(".v19Broadcast").forEach((c) => c.addEventListener("click", () => opened.push(c.dataset.v19Game)));
  await tick(300);
  const head = document.getElementById("v29MatchesHead");
  assert.ok(head, "a short head above the list");
  assert.equal(head.nextElementSibling, document.querySelector(".v19BroadcastList"));
  assert.match(text(head), /^Кто победит\?\s*Мой профиль и рейтинг →/);
  assert.match(text(head), /Голосуйте прямо в карточках матчей: победа с учётом ОТ и буллитов/);
  assert.match(text(head), /У прошедших матчей — как голосовали болельщики/);
  assert.match(text(head), /Прошлый игровой день: угадано 1 из 2 · \+27 XP/);
  const slotOf = (pk) => document.querySelector(`.v19Broadcast[data-v19-game="${pk}"] .v19BroadcastText > .v29Slot.v29CardSlot`);
  assert.ok(slotOf(9001) && !slotOf(9001).hidden, "a game ahead: the vote in its card");
  assert.deepEqual([...slotOf(9001).querySelectorAll(".v29Btn b")].map(text), ["NJD", "DET"]);
  assert.ok(!slotOf(9001).querySelector(".v29Mid"), "the card is narrow: no question between the buttons, the head says it");
  assert.ok(!/1\.8|1\.9/.test(text(slotOf(9001))), "no odds in the card vote either");
  assert.ok(slotOf(9004).querySelector(".v29Btn").disabled, "a game that is on: closed");
  assert.deepEqual([...slotOf(9004).querySelectorAll(".v29Pc")].map(text), [], "three votes: no percentages, they would say nothing");
  assert.ok(slotOf(9010).hidden, "an old game nobody voted on: nothing in its card");
  const old = slotOf(9011);
  assert.ok(!old.hidden, "an old game with votes: how the fans voted");
  assert.deepEqual([...old.querySelectorAll(".v29Pc")].map(text), ["75%", "25%"]);
  assert.ok(old.querySelector('[data-v29-pick="home"]').classList.contains("won"), "and who won");
  assert.equal(text(old.querySelector(".v29Line")), "Как голосовали болельщики · 12");
  // a vote in a card does not open the match; the card itself still does
  slotOf(9002).querySelector('[data-v29-pick="home"]').click();
  await tick(30);
  assert.deepEqual(opened, [], "the vote is not 'open the match'");
  assert.deepEqual(ctx.box.calls.find((c) => c.method === "POST").body, { game_pk: 9002, pick: "home" });
  assert.ok(slotOf(9002).querySelector('[data-v29-pick="home"]').classList.contains("mine"));
  // right after the pick: «Хотите угадать точный счёт? +25 XP», two counters in favour of the pick
  const sc = slotOf(9002).querySelector(".v29Score");
  assert.ok(sc, "the exact score is asked after the pick");
  assert.match(text(sc.querySelector(".v29ScQ")), /^Хотите угадать точный счёт\? \+25 XP$/);
  assert.deepEqual([...sc.querySelectorAll(".v29Step b")].map(text), ["2", "3"], "TBL 2 : 3 NYR — in favour of NYR, the pick");
  assert.ok(sc.querySelector("[data-v29-sc-save]"), "a button to save it");
  const plusAway = () => slotOf(9002).querySelector('[data-v29-sc="9002:away:1"]');
  plusAway().click();
  plusAway().click();
  await tick(10);
  assert.deepEqual([...slotOf(9002).querySelectorAll(".v29Step b")].map(text), ["4", "3"]);
  assert.ok(!slotOf(9002).querySelector("[data-v29-sc-save]"), "4:3 for TBL does not fit the pick: no saving");
  assert.match(text(slotOf(9002).querySelector(".v29ScBad")), /счёт в пользу NYR/);
  assert.deepEqual(opened, [], "the counters do not open the match");
  slotOf(9002).querySelector('[data-v29-sc="9002:home:1"]').click();
  slotOf(9002).querySelector('[data-v29-sc="9002:home:1"]').click();
  await tick(10);
  slotOf(9002).querySelector("[data-v29-sc-save]").click();
  await tick(30);
  assert.deepEqual(ctx.box.calls.filter((c) => c.method === "POST").at(-1).body, { game_pk: 9002, pick: "home", score: { home: 5, away: 4 } });
  assert.match(text(slotOf(9002).querySelector(".v29ScQ")), /^Ваш точный счёт/);
  assert.ok(slotOf(9002).querySelector(".v29ScOk"), "saved: a tick");
  assert.match(text(slotOf(9002).querySelector(".v29Line")), /Ваш выбор: NYR, счёт 4:5 ·/);
  document.querySelector('.v19Broadcast[data-v19-game="9002"] b').click();
  assert.deepEqual(opened, ["9002"]);
  // another day: the list is drawn again, the cards get their votes again
  document.querySelector(".v19BroadcastList").innerHTML = card(9001, "NJD — DET");
  await tick(300);
  assert.ok(slotOf(9001) && !slotOf(9001).hidden);
  assert.equal(document.querySelectorAll("#v29MatchesHead").length, 1, "one head");
  // the link opens "Мои"
  let follows = 0;
  document.querySelector('.tab[data-tab="follows"]').addEventListener("click", () => { follows += 1; });
  head.querySelector("[data-v29-me]").click();
  assert.equal(follows, 1);
  ctx.window.close();

  const guest = makeApp({ tab: "broadcasts", html: MATCHES_HTML, signedIn: false });
  await tick(300);
  assert.match(text(guest.document.getElementById("v29MatchesHead")), /Голосовать можно в приложении, открытом из Telegram-бота/);
  assert.ok(!/Прошлый игровой день/.test(text(guest.document.getElementById("v29MatchesHead"))));
  guest.window.close();
}

{
  // outside of Telegram: the buttons explain, nothing is sent; a closed vote is refused and the game is asked again
  const guest = makeApp({ signedIn: false });
  await tick(250);
  guest.document.querySelector('.v29Slot [data-v29-pick="home"]').click();
  await tick(10);
  assert.deepEqual(guest.box.alerts, ["Голосовать можно в приложении, открытом из Telegram-бота."]);
  assert.equal(guest.box.calls.filter((c) => c.method === "POST").length, 0);
  guest.window.close();

  const late = makeApp({ postError: "voting_closed" });
  await tick(250);
  late.document.querySelector('.v29Slot [data-v29-pick="home"]').click();
  await tick(30);
  assert.deepEqual(late.box.alerts, ["Матч уже начался — прогнозы на него закрыты."]);
  assert.ok(!late.document.querySelector(".v29Slot .v29Btn.mine"), "the pick is taken back");
  assert.ok(late.box.calls.some((c) => c.url.startsWith(`${API}/games?ids=9002`)), "and the game is asked again");
  late.window.close();

  const broken = makeApp({ postError: "HTTP 500" });
  await tick(250);
  broken.document.querySelector('.v29Slot [data-v29-pick="home"]').click();
  await tick(30);
  assert.deepEqual(broken.box.alerts, ["Не удалось сохранить прогноз. Попробуйте ещё раз."]);
  assert.ok(!broken.document.querySelector(".v29Btn.mine"), "a failed vote is taken back everywhere");
  assert.match(text(broken.document.querySelector(".v29Slot .v29Line")), /Проголосовали: 7/);
  broken.window.close();
}

{
  // no-spoilers: a finished game does not tell who won
  const done = block(9010, "TBL", "NYR", { open: false, state: "OFF", votes: { total: 12, home: 10, away: 2 }, my: { pick: "away", result: "win", xp: 26 }, settled: { winner: "away", home_xp: 1, away_xp: 26, score: { home: 2, away: 3 } } });
  const open = makeApp({ games: [done], tab: "broadcasts", html: MATCHES_HTML });
  await tick(300);
  const slot = open.document.querySelector('.v19Broadcast[data-v19-game="9010"] .v29Slot');
  assert.match(text(slot), /✓ Угадали · \+26 XP/);
  assert.ok(slot.querySelector('[data-v29-pick="away"]').classList.contains("won"));
  open.window.close();
  const hidden = makeApp({ games: [done], spoilers: true, tab: "broadcasts", html: MATCHES_HTML });
  await tick(300);
  const s2 = hidden.document.querySelector('.v19Broadcast[data-v19-game="9010"] .v29Slot');
  assert.match(text(s2), /Итог скрыт: режим без спойлеров/);
  assert.ok(!s2.querySelector(".won") && !/%/.test(text(s2)) && !/XP/.test(text(s2)), "no winner, no split, no points");
  assert.ok(!/Прошлый игровой день/.test(text(hidden.document.getElementById("v29MatchesHead"))), "not even last night's score");
  hidden.window.close();
}

{
  // the match screen: the vote right under the head of the match, the question in the middle
  const ctx = makeApp({ html: '<div class="v15Profile v26Match" id="v26Root"><div id="v15Back"></div><div id="v26Head">head</div><div id="v26Wl"></div><div id="v26Body"></div></div>' });
  ctx.window.HOHV26 = { state: { gamePk: 9001 } };
  ctx.document.getElementById("v26Body").innerHTML = "<p>goals</p>"; // any change of the page
  await tick(300);
  const slot = ctx.document.getElementById("v29Match");
  assert.ok(slot, "the vote is on the match screen");
  assert.equal(ctx.document.getElementById("v26Head").nextElementSibling, slot, "under the head, above the Winline block");
  assert.equal(text(slot.querySelector(".v29Mid")), "Ктопобедит?");
  assert.deepEqual([...slot.querySelectorAll(".v29Btn b")].map(text), ["NJD", "DET"]);
  assert.ok(!/1\.88|1\.92/.test(text(slot)), "no odds");
  ctx.window.close();
}

{
  // "Мои": the profile of the player and the table
  const ctx = makeApp({ tab: "follows", html: '<div id="v15Theme">theme</div><div id="other">follows</div>' });
  await tick(250);
  const box = ctx.document.getElementById("v29Me");
  assert.ok(box, "the card is on the Мои screen");
  assert.equal(ctx.document.getElementById("view").firstElementChild, box, "at the top");
  const prof = box.querySelector(".v29Prof");
  assert.match(text(prof), /^Твой профиль/);
  assert.equal(text(prof.querySelector(".lvl")), "Уровень 2");
  assert.equal(text(prof.querySelector(".note")), "Первая победа");
  assert.equal(text(prof.querySelector(".xp b")), "37 XP");
  assert.equal(text(prof.querySelector(".xp span")), "До уровня 3: 23 XP");
  assert.equal(prof.querySelector(".v29Bar i").style.width, "42%");
  assert.deepEqual([...prof.querySelectorAll(".v29Stats b")].map(text), ["4", "100%", "#1"]);
  assert.ok(prof.querySelector(".v29Badge svg"), "the medal");
  assert.ok(!/Задайте ник/.test(text(prof)), "a person with a nickname is not asked for one");
  prof.querySelector("[data-v29-rules]").click();
  assert.match(text(box.querySelector(".v29Rules")), /\+10 XP сверху — угадали победу андердога/);
  assert.match(text(box.querySelector(".v29Rules")), /Уровни: 1 — 0 · 2 — 20 · 3 — 60 · 4 — 120 · 5 — 220 · 6 — 380 · 7 — 620 · 8 — 1 000 · 9 — 1 600 · 10 — 2 500 XP/);
  assert.match(text(box.querySelector(".v29Rules")), /\+25 XP сверху — угадали точный счёт матча/);

  const board = box.querySelector(".v29Board");
  assert.equal(board.querySelectorAll("li").length, 10, "the top ten");
  assert.ok(board.querySelector("li").classList.contains("me"), "my row is marked");
  assert.equal(board.querySelector("li .av img").getAttribute("src"), "/api/telegram-center-v22/avatars/101");
  assert.match(text(board.querySelector("li")), /@kaprizov97\s*Уровень 2 · угадано 1 из 2\s*50 XP$/);
  board.querySelector("[data-v29-board-more]").click();
  assert.equal(box.querySelectorAll(".v29Board li").length, 12, "the whole table");
  box.querySelector('[data-v29-period="month"]').click();
  await tick(30);
  assert.ok(ctx.box.calls.some((c) => c.url === `${API}/leaderboard?period=month`));
  assert.ok(box.querySelector('[data-v29-period="month"]').classList.contains("on"));
  assert.match(text(box.querySelector(".v29Board li b")), /100 XP/);

  const sw = box.querySelector("[data-v29-digest]");
  assert.ok(sw.classList.contains("on"), "the morning message is on");
  sw.click();
  await tick(20);
  assert.deepEqual(ctx.box.calls.find((c) => c.method === "PUT").body, { morning_digest: false });
  assert.ok(!box.querySelector("[data-v29-digest]").classList.contains("on"));

  // another tab: the card goes away, even when the layer of that tab keeps the rest of the page
  ctx.box.tab = "games";
  ctx.document.getElementById("view").appendChild(ctx.document.createElement("p"));
  await tick(250);
  assert.ok(!ctx.document.getElementById("v29Me"));
  ctx.window.close();

  const guest = makeApp({ tab: "follows", signedIn: false, html: '<div id="v15Theme">theme</div>' });
  await tick(250);
  assert.match(text(guest.document.querySelector(".v29Prof")), /доступны в приложении, открытом из Telegram-бота/);
  assert.equal(guest.document.querySelectorAll(".v29Board li").length, 10, "the table is open to everybody");
  guest.window.close();
}

// ---- 7) the exact score: +25 XP on top of the right winner --------------------------------------------------------------------
{
  const { validScore, isExactScore, XP_RULES } = await import("../cloudflare-worker/src/telegram-center-v29-predictions-data.js");
  assert.equal(XP_RULES.exact, 25);
  assert.deepEqual(validScore("home", { home: 3, away: 2 }), { home: 3, away: 2 });
  assert.equal(validScore("home", { home: 2, away: 3 }), null, "against the pick");
  assert.equal(validScore("away", { home: 2, away: 2 }), null, "no draw: there is always a winner");
  assert.equal(validScore("away", { home: 1, away: 16 }), null, "up to 15");
  assert.equal(validScore("away", { home: "1", away: 2.5 }), null);
  assert.equal(validScore("draw", { home: 1, away: 2 }), null);
  assert.ok(isExactScore({ score_home: 2, score_away: 3 }, 2, 3));
  assert.ok(!isExactScore({ score_home: null, score_away: null }, 0, 0), "no guess, no exact score");
  const nowBefore = Date.now;
  Date.now = () => NOW; // the signed requests of the test are dated NOW

  const db2 = makeDb();
  const env2 = { DB: db2, TELEGRAM_CENTER_BOT_TOKEN: TOKEN };
  const r = db2.raw;
  for (const tri of ["TBL", "NYR"]) r.prepare("INSERT INTO teams(tri_code,name_en,name_ru,logo_url) VALUES(?,?,?,?)").run(tri, tri, tri, `https://l.test/${tri}.svg`);
  const game = r.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score,period_type) VALUES(?,?,?,?,?,?,?,?,?,?)");
  game.run(9101, "20262027", 2, "2026-10-13T23:15:00Z", "FUT", "NYR", "TBL", 0, 0, null);
  game.run(9110, "20262027", 2, "2026-10-12T23:00:00Z", "OFF", "NYR", "TBL", 2, 3, "SO"); // TBL won 3:2 in the shootout
  const call2 = async (path, { method = "GET", user = null, body } = {}) => {
    const headers = {};
    if (user) headers["X-Telegram-Init-Data"] = initDataFor(user);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await handleTelegramCenterV29(new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env2, path.split("?")[0]);
    return { status: res.status, body: await res.json() };
  };
  const post = (body) => call2(`${API}/predictions`, { method: "POST", user: A, body });
  const scoreRow = () => ({ ...r.prepare("SELECT pick,score_home,score_away FROM fan_predictions WHERE telegram_user_id=101 AND game_pk=9101").get() });
  let res = await post({ game_pk: 9101, pick: "away", score: { home: 2, away: 3 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.game.my.score, { home: 2, away: 3 }, "the guess is kept with the pick");
  for (const bad of [{ home: 3, away: 2 }, { home: 2, away: 2 }, { home: 1, away: 99 }, { home: "x", away: 1 }]) {
    const no = await post({ game_pk: 9101, pick: "away", score: bad });
    assert.deepEqual([no.status, no.body.error], [400, "invalid_score"], JSON.stringify(bad));
  }
  assert.deepEqual(scoreRow(), { pick: "away", score_home: 2, score_away: 3 }, "a refused guess changes nothing");
  res = await post({ game_pk: 9101, pick: "away" });
  assert.deepEqual(res.body.game.my.score, { home: 2, away: 3 }, "the pick again without a score keeps the score");
  res = await post({ game_pk: 9101, pick: "home" });
  assert.equal(res.body.game.my.score, null, "the other team: the old score does not fit and is dropped");
  assert.deepEqual(scoreRow(), { pick: "home", score_home: null, score_away: null });
  res = await post({ game_pk: 9101, pick: "home", score: { home: 4, away: 1 } });
  assert.deepEqual(res.body.game.my.score, { home: 4, away: 1 });
  res = await post({ game_pk: 9101, pick: "home", score: null });
  assert.equal(res.body.game.my.score, null, "null takes the guess back");
  Date.now = () => Date.parse("2026-10-13T23:16:00Z");
  assert.equal((await post({ game_pk: 9101, pick: "home", score: { home: 4, away: 1 } })).body.error, "voting_closed", "no guesses after the start");
  Date.now = () => NOW;

  // the settlement: the exact final score of the shootout game (3:2 for TBL) brings 25 more
  const pick = r.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,game_date,season_id,score_home,score_away) VALUES(?,?,?,?,?,?,?,?)");
  for (const id of [201, 202, 203, 204]) r.prepare("INSERT INTO telegram_users(telegram_user_id,first_name) VALUES(?,?)").run(id, `U${id}`);
  pick.run(201, 9110, "away", "TBL", "2026-10-12", "20262027", 2, 3);
  pick.run(202, 9110, "away", "TBL", "2026-10-12", "20262027", 1, 4);
  pick.run(203, 9110, "away", "TBL", "2026-10-12", "20262027", null, null);
  pick.run(204, 9110, "home", "NYR", "2026-10-12", "20262027", 3, 2);
  const s = await runFanPredictionSettlement(env2, { now: Date.parse("2026-10-13T05:00:00Z") });
  assert.equal(s.games, 1);
  const got = (uid) => ({ ...r.prepare("SELECT result,xp,exact FROM fan_predictions WHERE telegram_user_id=? AND game_pk=9110").get(uid) });
  assert.deepEqual(got(201), { result: "win", xp: 11 + 25, exact: 1 }, "the right winner (11) and the exact score (25)");
  assert.deepEqual(got(202), { result: "win", xp: 11, exact: 0 }, "the right winner, another score");
  assert.deepEqual(got(203), { result: "win", xp: 11, exact: 0 }, "no guess");
  assert.deepEqual(got(204), { result: "loss", xp: 1, exact: 0 }, "the wrong winner: never an exact score");
  const settled = await call2(`${API}/games?ids=9110`, { user: { id: 201, first_name: "U201" } });
  assert.deepEqual(settled.body.games[0].my, { pick: "away", result: "win", xp: 36, score: { home: 2, away: 3 }, exact: true });
  const meExact = await call2(`${API}/me`, { user: { id: 201, first_name: "U201" } });
  assert.equal(meExact.body.recent[0].exact, true);
  assert.equal(meExact.body.level.name, "Уровень 2", "36 XP: level 2 after one good evening");
  const digest = await runFanPredictionDigest(env2, { now: Date.parse("2026-10-13T07:30:00Z"), dryRun: true });
  assert.match(digest.messages.find((m) => m.user_id === 201).text, /✅ TBL — NYR: вы выбрали TBL · 🎯 точный счёт · \+36 XP/);
  assert.ok(!/🎯/.test(digest.messages.find((m) => m.user_id === 202).text));
  Date.now = nowBefore;
}

console.log("predictions validation passed");
