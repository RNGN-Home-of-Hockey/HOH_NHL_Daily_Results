// v34: «Мои итоги» — the month or the season of a fan as a story-sized card, shared to a Telegram story or saved. The API runs on
// SQLite with the tables of the real migrations; the screen in jsdom (the drawing itself needs a real canvas, the lines are tested).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { SCRIPT_PATH, MAX_CARD_BYTES, CARDS_PER_DAY, periodOf, recapOf, handleTelegramCenterV34 } from "../cloudflare-worker/src/telegram-center-v34-recap.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

// ---- 1) the rules ---------------------------------------------------------------------------------------------------------------
const NOW = Date.parse("2026-10-15T09:00:00Z");
assert.deepEqual(periodOf("month", NOW), { period: "month", season: "20262027", label: "Октябрь 2026", sql: "p.game_date>=? AND p.game_date<=?", args: ["2026-10-01", "2026-10-31"] });
assert.deepEqual(periodOf("season", NOW), { period: "season", season: "20262027", label: "Сезон 2026/27", sql: "p.season_id=?", args: ["20262027"] });
const r = recapOf([
  { pick_tri: "UTA", result: "win", xp: 26, exact: 1, odds_at_pick: 2.65, away_tri: "UTA", home_tri: "EDM" },
  { pick_tri: "UTA", result: "win", xp: 11, exact: 0, odds_at_pick: 1.6, away_tri: "UTA", home_tri: "VGK" },
  { pick_tri: "TOR", result: "loss", xp: 1, exact: 0, odds_at_pick: 1.4, away_tri: "TOR", home_tri: "MTL" },
  { pick_tri: "UTA", result: "win", xp: 11, exact: 0, odds_at_pick: 1.9, away_tri: "SJS", home_tri: "UTA" },
  { pick_tri: "MTL", result: null, xp: 0, exact: 0, odds_at_pick: 3.1, away_tri: "MTL", home_tri: "BOS" }, // not played yet
], { UTA: "Юта Маммот" });
assert.deepEqual(r, {
  picks: 5, settled: 4, correct: 3, accuracy: 75, xp: 49, exact: 1, best_streak: 2,
  best_pick: { tri: "UTA", name: "Юта Маммот", odds: 2.65, game: "UTA — EDM" },
  favorite: { tri: "UTA", name: "Юта Маммот", picks: 3 },
}, "the best guess is the right pick with the biggest odds, not the open one at 3.10");
assert.deepEqual(recapOf([]), { picks: 0, settled: 0, correct: 0, accuracy: null, xp: 0, exact: 0, best_streak: 0, best_pick: null, favorite: null });

// ---- 2) the API on SQLite ---------------------------------------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => migration(file).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
for (const t of ["teams", "games", "telegram_users"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(migration("0048_fan_predictions.sql"));
raw.exec(migration("0050_fan_prediction_scores.sql"));
raw.exec(migration("0052_fan_streaks_privacy.sql"));
raw.exec(migration("0054_fan_share_cards.sql"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const TOKEN = "123456:TEST";
const env = { DB: { prepare: (sql) => stmt(sql) }, TELEGRAM_CENTER_BOT_TOKEN: TOKEN };
const initDataFor = (user) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), query_id: "AAE", user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
};
const U = { id: 701, first_name: "Олег" };
const realNow = Date.now;
Date.now = () => NOW;
const call = async (path, { method = "GET", user = null, body, type } = {}) => {
  const headers = {};
  if (user) headers["X-Telegram-Init-Data"] = initDataFor(user);
  if (type) headers["Content-Type"] = type;
  return handleTelegramCenterV34(new Request(`https://hoh.test${path}`, { method, headers, body }), env, path.split("?")[0]);
};
{
  for (const [tri, ru] of [["UTA", "Юта Маммот"], ["EDM", "Эдмонтон Ойлерз"]]) raw.prepare("INSERT INTO teams(tri_code,name_en,name_ru) VALUES(?,?,?)").run(tri, tri, ru);
  raw.prepare("INSERT INTO telegram_users(telegram_user_id,first_name) VALUES(?,?)").run(701, "Олег");
  const game = raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score) VALUES(?,?,?,?,?,?,?,?,?)");
  game.run(1, "20262027", 2, "2026-10-10T00:00:00Z", "OFF", "EDM", "UTA", 1, 3);
  game.run(2, "20262027", 2, "2026-09-30T23:00:00Z", "OFF", "EDM", "UTA", 4, 1); // September: the season, not the month
  const pick = raw.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,odds_at_pick,game_date,season_id,result,xp,exact,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  pick.run(701, 1, "away", "UTA", 2.65, "2026-10-09", "20262027", "win", 26, 0, "x");
  pick.run(701, 2, "away", "UTA", 2.4, "2026-09-30", "20262027", "loss", 1, 0, "x");

  assert.equal((await call("/api/telegram-center-v34/recap")).status, 401);
  assert.equal((await call("/api/telegram-center-v34/recap?period=year", { user: U })).status, 400);
  const month = await (await call("/api/telegram-center-v34/recap?period=month", { user: U })).json();
  assert.equal(month.label, "Октябрь 2026");
  assert.deepEqual([month.recap.picks, month.recap.correct, month.recap.accuracy], [1, 1, 100], "only October");
  assert.equal(month.recap.best_pick.name, "Юта Маммот");
  assert.deepEqual(month.level, { n: 2, note: "Подносчик шайб", xp: 27 }, "the level of all the points");
  assert.equal(month.better_pct, null, "nobody to compare with");
  const season = await (await call("/api/telegram-center-v34/recap?period=season", { user: U })).json();
  assert.deepEqual([season.label, season.recap.picks, season.recap.accuracy], ["Сезон 2026/27", 2, 50]);

  // the picture: a PNG or a JPEG, at most 1.5 MB, at most 20 a day, public for 7 days
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  assert.equal((await call("/api/telegram-center-v34/cards?period=month", { method: "POST", body: png, type: "image/png" })).status, 401);
  assert.equal((await call("/api/telegram-center-v34/cards?period=month", { method: "POST", user: U, body: new Uint8Array([1, 2, 3, 4, 5]), type: "image/png" })).status, 415, "only real pictures");
  assert.equal((await call("/api/telegram-center-v34/cards?period=month", { method: "POST", user: U, body: new Uint8Array(MAX_CARD_BYTES + 1).fill(0x89), type: "image/png" })).status, 413);
  assert.equal((await call("/api/telegram-center-v34/cards?period=week", { method: "POST", user: U, body: png, type: "image/png" })).status, 400);
  const up = await (await call("/api/telegram-center-v34/cards?period=month", { method: "POST", user: U, body: png, type: "image/png" })).json();
  assert.match(up.url, /^https:\/\/hoh\.test\/api\/telegram-center-v34\/cards\/[a-f0-9]{24}\.png$/, "a public address on the host that was asked");
  const path = new URL(up.url).pathname;
  const pic = await call(path);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("Content-Type"), "image/png");
  assert.match(pic.headers.get("Cache-Control"), /public/);
  assert.deepEqual(new Uint8Array(await pic.arrayBuffer()), png, "the same bytes back");
  assert.equal((await call("/api/telegram-center-v34/cards/ffffffffffffffffffffffff.png")).status, 404);
  raw.prepare("UPDATE fan_share_cards SET created_at=datetime('now','-8 days')").run();
  assert.equal((await call(path)).status, 404, "older than 7 days: gone");
  await call("/api/telegram-center-v34/cards?period=month", { method: "POST", user: U, body: png, type: "image/png" });
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM fan_share_cards").get().n, 1, "the old ones are cleaned when a new one comes");
  for (let i = 0; i < CARDS_PER_DAY - 1; i++) await call("/api/telegram-center-v34/cards?period=season", { method: "POST", user: U, body: png, type: "image/png" });
  assert.equal((await call("/api/telegram-center-v34/cards?period=season", { method: "POST", user: U, body: png, type: "image/png" })).status, 429, `${CARDS_PER_DAY} a day at most`);
  assert.equal((await call("/api/telegram-center-v34/other")).status, 404);
  assert.equal((await call("/api/telegram-center-v34/recap", { method: "POST", user: U })).status, 405);
}
Date.now = realNow;

// ---- 3) the routes ----------------------------------------------------------------------------------------------------------------
const script = await (await handleTelegramCenterV34(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).text();
{
  assert.match(script, /^\(function\(\)\{const __name=/);
  assert.equal(await handleTelegramCenterV34(new Request("https://x.test/api/other"), env, "/api/other"), null);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v34-recap.js?build=34.0"));
  assert.ok(shell.indexOf("/telegram-app/v34-recap.js") > shell.indexOf("/telegram-app/v33-fan.js"));
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).status, 200);
}

// ---- 4) the screen ----------------------------------------------------------------------------------------------------------------
const RECAP = { ok: true, period: "month", label: "Октябрь 2026", recap: recapOf([
  { pick_tri: "UTA", result: "win", xp: 26, exact: 1, odds_at_pick: 2.65, away_tri: "UTA", home_tri: "EDM" },
  { pick_tri: "UTA", result: "win", xp: 11, exact: 0, odds_at_pick: 1.6, away_tri: "UTA", home_tri: "VGK" },
], { UTA: "Юта Маммот" }), level: { n: 4, note: "Голос трибуны", xp: 150 }, better_pct: 63 };
function makeApp({ recap = RECAP, story = true, signedIn = true } = {}) {
  const dom = new JSDOM('<!doctype html><html class="v15Light"><head></head><body><main id="view"><section id="v29Me"></section><section id="v33Ach"></section></main></body></html>', { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const calls = { api: [], fetch: [], story: [], download: [] };
  if (signedIn) window.Telegram = { WebApp: { initData: "query_id=AAE&hash=x", ...(story ? { shareToStory: (url, opt) => calls.story.push({ url, opt }) } : {}), downloadFile: (o) => calls.download.push(o) } };
  window.alert = () => {};
  window.HOHV15 = { state: { profile: false }, currentTab: () => "follows", api: async (url) => { calls.api.push(url); return recap; } };
  window.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new window.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type })); };
  window.fetch = async (url, init) => { calls.fetch.push({ url, method: init.method, type: init.headers["Content-Type"], init: init.headers["X-Telegram-Init-Data"] }); return new Response(JSON.stringify({ ok: true, url: "https://x.test/api/telegram-center-v34/cards/aaaaaaaaaaaaaaaaaaaaaaaa.png" }), { status: 200 }); };
  window.eval(script);
  return { window, document: window.document, calls, R: window.HOHV34 };
}
{
  const { R, window } = makeApp();
  assert.deepEqual(JSON.parse(JSON.stringify(R.cardLines(RECAP))), {
    title: "Мои итоги", period: "Октябрь 2026", big: "100%", sub: "угадано 2 из 2",
    rows: [["Очки", "+37 XP"], ["Лучшая серия", "2 подряд"], ["Точный счёт", "1 раз"], ["Лучший прогноз", "Юта Маммот при кэфе 2.65"], ["Чаще всего выбирали", "Юта Маммот — 2 раза"]],
    level: "Уровень 4 · Голос трибуны", better: "Точнее, чем у 63% болельщиков",
  });
  assert.equal(R.cardLines({ ...RECAP, better_pct: 0 }).better, "", "never «точнее, чем у 0%»");
  assert.equal(R.cardLines({ label: "Сезон 2026/27", recap: recapOf([]) }).sub, "прогнозов пока нет");
  window.close();
}
{
  const { window, document, calls } = makeApp();
  await tick(200);
  const box = document.getElementById("v34Box");
  assert.ok(box, "«Мои итоги» on «Мои»");
  assert.equal(box.previousElementSibling.id, "v29Me", "under the profile");
  assert.equal(box.nextElementSibling.id, "v33Ach", "above the achievements");
  const month = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"][new Date().getMonth()];
  assert.deepEqual([...box.querySelectorAll("button")].map(text), [month, "Сезон"]);
  box.querySelector('[data-v34-open="month"]').click();
  await tick(30);
  assert.deepEqual(calls.api, ["/api/telegram-center-v34/recap?period=month"]);
  const panel = document.querySelector(".v34Panel");
  assert.ok(panel.querySelector("canvas"), "the card is drawn");
  assert.deepEqual([...panel.querySelectorAll(".v34Acts button")].map(text), ["Поделиться в сторис", "Сохранить картинку", "Закрыть"]);
  panel.querySelector("[data-v34-share]").click();
  await tick(30);
  assert.deepEqual(calls.fetch.map((f) => [f.url, f.method, f.type, f.init]), [["/api/telegram-center-v34/cards?period=month", "POST", "image/png", "query_id=AAE&hash=x"]], "the picture goes up signed by Telegram");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.story)), [{ url: "https://x.test/api/telegram-center-v34/cards/aaaaaaaaaaaaaaaaaaaaaaaa.png", opt: { text: "Мои итоги в HOH NHL Center 🏒", widget_link: { url: "https://hoh.109-172-113-187.sslip.io", name: "HOH NHL" } } }]);
  panel.querySelector("[data-v34-save]").click();
  await tick(30);
  assert.equal(calls.fetch.length, 1, "the same picture is not uploaded twice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.download)), [{ url: "https://x.test/api/telegram-center-v34/cards/aaaaaaaaaaaaaaaaaaaaaaaa.png", file_name: "hoh-itogi-month.png" }]);
  panel.querySelector("[data-v34-close]").click();
  assert.equal(document.querySelector(".v34Shade"), null);
  window.close();
}
{
  // an old Telegram without stories: only «Сохранить»; no picks yet: the buttons wait; a guest: no block
  const old = makeApp({ story: false });
  await tick(200);
  old.document.querySelector('[data-v34-open="season"]').click();
  await tick(30);
  assert.deepEqual([...old.document.querySelectorAll(".v34Acts button")].map(text), ["Сохранить картинку", "Закрыть"]);
  old.window.close();
  const empty = makeApp({ recap: { ok: true, label: "Октябрь 2026", recap: recapOf([]), level: { n: 1, note: "Заливщик льда", xp: 0 }, better_pct: null } });
  await tick(200);
  empty.document.querySelector('[data-v34-open="month"]').click();
  await tick(30);
  assert.ok(empty.document.querySelector("[data-v34-share]").disabled && empty.document.querySelector("[data-v34-save]").disabled);
  assert.equal(text(empty.document.querySelector(".v34Msg")), "Сделайте первые прогнозы — и здесь появятся ваши итоги");
  empty.window.close();
  const guest = makeApp({ signedIn: false });
  await tick(200);
  assert.equal(guest.document.getElementById("v34Box"), null);
  guest.window.close();
}

console.log("recap v34 validation passed");
