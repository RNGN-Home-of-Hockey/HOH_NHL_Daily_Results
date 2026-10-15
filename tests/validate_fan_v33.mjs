// v33: the fan himself — the first visit (team, players, what the person likes → the usual follows), the achievements with easy
// first steps, and the counting behind them. The API runs on SQLite with the tables of the real migrations; the screen in jsdom.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import {
  SCRIPT_PATH, ACHIEVEMENTS, FRESH_NEWS_HOURS, tierOf, achievementsOf, daysInRow, moscowDate, cleanInterests, seasonNow, handleTelegramCenterV33,
} from "../cloudflare-worker/src/telegram-center-v33-fan.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

// ---- 1) the rules ---------------------------------------------------------------------------------------------------------------
assert.deepEqual(tierOf(0, [3, 7, 14, 30]), { tier: 0, next: 3 });
assert.deepEqual(tierOf(3, [3, 7, 14, 30]), { tier: 1, next: 7 }, "the first step is reached at its value");
assert.deepEqual(tierOf(40, [3, 7, 14, 30]), { tier: 4, next: null }, "all done");
assert.deepEqual(ACHIEVEMENTS.map((a) => a.steps[0]), [3, 1, 3, 1, 1, 3, 1, 1], "the first step of every achievement is easy");
const ach = achievementsOf({ days: 4, streams: 0, picks: 12, exact: 1 });
assert.deepEqual(ach.find((a) => a.key === "days"), { key: "days", icon: "📅", title: "Каждый день с хоккеем", hint: "дней подряд в приложении", value: 4, tier: 1, tiers: 4, next: 7, steps: [3, 7, 14, 30] });
assert.equal(ach.find((a) => a.key === "picks").tier, 2);
assert.equal(ach.find((a) => a.key === "streams").next, 1);
assert.equal(daysInRow(["2026-10-15", "2026-10-14", "2026-10-13", "2026-10-11"], "2026-10-15"), 3);
assert.equal(daysInRow(["2026-10-14", "2026-10-13"], "2026-10-15"), 2, "today is not over: yesterday's run still counts");
assert.equal(daysInRow(["2026-10-13"], "2026-10-15"), 0, "a day missed: the run is over");
assert.equal(daysInRow([], "2026-10-15"), 0);
assert.equal(moscowDate(Date.parse("2026-10-15T21:30:00Z")), "2026-10-16", "the day of Moscow");
assert.deepEqual(cleanInterests(["bets", "results", "bets", "spam"]), ["bets", "results"]);
assert.equal(cleanInterests("bets"), null);
assert.equal(seasonNow(Date.parse("2026-10-15T00:00:00Z")), "20262027");

// ---- 2) the API on SQLite --------------------------------------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => migration(file).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
for (const t of ["teams", "players", "games", "player_game_stats", "telegram_users", "subscriptions"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(createOf("0019_sports_news.sql", "sports_news"));
raw.exec(migration("0048_fan_predictions.sql"));
raw.exec(migration("0050_fan_prediction_scores.sql"));
raw.exec(migration("0052_fan_streaks_privacy.sql"));
raw.exec(migration("0053_fan_onboarding_activity.sql"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const TOKEN = "123456:TEST";
const env = { DB: { prepare: (sql) => stmt(sql) }, TELEGRAM_CENTER_BOT_TOKEN: TOKEN };
const NOW = Date.parse("2026-10-15T09:00:00Z");
const initDataFor = (user) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), query_id: "AAE", user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
};
const U = { id: 501, first_name: "Анна" };
const realNow = Date.now;
Date.now = () => NOW;
const call = async (path, { method = "GET", user = null, body } = {}) => {
  const headers = {};
  if (user) headers["X-Telegram-Init-Data"] = initDataFor(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handleTelegramCenterV33(new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, path.split("?")[0]);
  return { status: res.status, body: await res.json(), cache: res.headers.get("Cache-Control") };
};
{
  for (const [tri, ru, active] of [["UTA", "Юта Маммот", 1], ["EDM", "Эдмонтон Ойлерз", 1], ["ARI", "Аризона Койотис", 0]]) raw.prepare("INSERT INTO teams(tri_code,name_en,name_ru,active,logo_url) VALUES(?,?,?,?,?)").run(tri, tri, ru, active, `https://l.test/${tri}.svg`);
  const pl = raw.prepare("INSERT INTO players(player_id,full_name_en,full_name_ru,position_code,current_team_tri) VALUES(?,?,?,?,?)");
  pl.run(1, "Clayton Keller", "Клейтон Келлер", "R", "UTA");
  pl.run(2, "Nick Schmaltz", "Ник Шмалц", "C", "UTA");
  pl.run(3, "Mikhail Sergachev", "Михаил Сергачев", "D", "UTA");
  pl.run(4, "Connor McDavid", "Коннор Макдэвид", "C", "EDM");
  const game = raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score) VALUES(?,?,?,?,?,?,?,?,?)");
  game.run(10, "20262027", 2, "2026-10-10T00:00:00Z", "OFF", "UTA", "EDM", 3, 2);
  game.run(11, "20262027", 2, "2026-10-12T00:00:00Z", "OFF", "EDM", "UTA", 1, 4);
  game.run(12, "20252026", 2, "2026-03-01T00:00:00Z", "OFF", "UTA", "EDM", 9, 0); // the last season: not counted
  game.run(13, "20262027", 2, "2026-10-05T00:00:00Z", "OFF", "EDM", "UTA", 5, 1);
  const ps = raw.prepare("INSERT INTO player_game_stats(game_pk,player_id,team_tri,goals,assists,points) VALUES(?,?,?,?,?,?)");
  ps.run(10, 1, "UTA", 0, 2, 2); ps.run(11, 1, "UTA", 1, 2, 3); // Keller 5
  ps.run(10, 2, "UTA", 2, 0, 2); ps.run(11, 2, "UTA", 2, 1, 3); // Schmaltz 5, more goals
  ps.run(10, 3, "UTA", 0, 1, 1); ps.run(12, 3, "UTA", 5, 5, 10); // Sergachev 1 this season
  ps.run(10, 4, "EDM", 1, 1, 2);
}
{
  const teams = await call("/api/telegram-center-v33/onboarding");
  assert.deepEqual(teams.body.teams.map((t) => t.tri), ["EDM", "UTA"], "the active teams in the order of their Russian names (Э before Ю), not the gone ones");
  assert.match(teams.cache, /max-age=3600/);
  const stars = await call("/api/telegram-center-v33/teams/UTA/stars");
  assert.deepEqual(stars.body.players.map((p) => [p.name, p.points, p.goals]), [["Ник Шмалц", 5, 4], ["Клейтон Келлер", 5, 1], ["Михаил Сергачев", 1, 0]], "the points of this season, then the goals");
  assert.equal(stars.body.players[0].photo, "https://assets.nhle.com/mugs/nhl/20262027/UTA/2.png");
  assert.equal((await call("/api/telegram-center-v33/teams/uta/stars")).status, 404, "a team code is three capital letters");

  // my page: a guest is not let in; a new fan has nothing yet
  assert.equal((await call("/api/telegram-center-v33/me")).status, 401);
  const fresh = await call("/api/telegram-center-v33/me", { user: U });
  assert.deepEqual([fresh.body.onboarded, fresh.body.follows, fresh.body.interests], [false, 0, []]);
  assert.ok(fresh.body.achievements.every((a) => a.tier === 0 && a.value === 0));

  // the activity: an open once a day, every broadcast, fresh news only
  const act = (body) => call("/api/telegram-center-v33/activity", { method: "POST", user: U, body });
  assert.equal((await act({ kind: "open" })).body.day, "2026-10-15");
  await act({ kind: "open" });
  await act({ kind: "stream" });
  await act({ kind: "stream" });
  raw.prepare("INSERT INTO sports_news(news_id,source,source_key,source_url,title,published_at) VALUES(?,?,?,?,?,?)").run(7, "sportsru", "a", "https://x/a", "Свежая", "2026-10-15T07:00:00.000Z");
  raw.prepare("INSERT INTO sports_news(news_id,source,source_key,source_url,title,published_at) VALUES(?,?,?,?,?,?)").run(8, "sportsru", "b", "https://x/b", "Старая", "2026-10-10T07:00:00.000Z");
  assert.equal((await act({ kind: "news", news_id: 7 })).body.counted, true);
  assert.equal((await act({ kind: "news", news_id: 8 })).body.counted, false, `older than ${FRESH_NEWS_HOURS} hours: not counted`);
  assert.equal((await act({ kind: "news", news_id: 99 })).body.counted, false, "an unknown news");
  assert.equal((await act({ kind: "like" })).status, 400);
  assert.equal((await act({ kind: "news" })).status, 400);
  const day = raw.prepare("SELECT opens,streams,news FROM fan_activity WHERE telegram_user_id=501 AND day='2026-10-15'").get();
  assert.deepEqual({ ...day }, { opens: 1, streams: 2, news: 1 });
  // the days before: a run of 3 with today
  raw.prepare("INSERT INTO fan_activity(telegram_user_id,day,opens) VALUES(501,'2026-10-14',1),(501,'2026-10-13',1),(501,'2026-10-11',1)").run();

  // the picks, the exact scores, the streak, the brave picks, the follows
  const pick = raw.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,odds_at_pick,game_date,season_id,result,exact,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  pick.run(501, 10, "home", "UTA", 2.4, "2026-10-09", "20262027", "win", 1, "x");
  pick.run(501, 11, "away", "UTA", 1.6, "2026-10-11", "20262027", "win", 0, "x");
  pick.run(501, 12, "home", "UTA", 1.5, "2026-02-28", "20252026", "loss", 0, "x");
  pick.run(501, 13, "away", "UTA", 3.1, "2026-10-04", "20262027", "loss", 0, "x"); // a brave pick that missed: not brave enough to count
  raw.prepare("INSERT INTO subscriptions(telegram_user_id,subject_type,subject_key) VALUES(501,'team','UTA'),(501,'player','1'),(501,'game','10')").run();
  const me = await call("/api/telegram-center-v33/me", { user: U });
  const v = Object.fromEntries(me.body.achievements.map((a) => [a.key, a.value]));
  assert.deepEqual(v, { days: 3, streams: 2, news: 1, picks: 4, exact: 1, streak: 2, brave: 1, follows: 2 }, "a game subscription is not a follow; the streak in the order of the games");
  assert.equal(me.body.follows, 2);

  // the answers of the first visit
  assert.equal((await call("/api/telegram-center-v33/me", { method: "PUT", user: U, body: {} })).status, 400);
  assert.equal((await call("/api/telegram-center-v33/me", { method: "PUT", user: U, body: { interests: "bets" } })).status, 400);
  const put = await call("/api/telegram-center-v33/me", { method: "PUT", user: U, body: { interests: ["bets", "streams", "bets", "x"], onboarded: true } });
  assert.deepEqual(put.body.interests, ["bets", "streams"]);
  const after = await call("/api/telegram-center-v33/me", { user: U });
  assert.deepEqual([after.body.onboarded, after.body.interests], [true, ["bets", "streams"]]);
  const first = raw.prepare("SELECT onboarded_at FROM fan_profiles WHERE telegram_user_id=501").get().onboarded_at;
  await call("/api/telegram-center-v33/me", { method: "PUT", user: U, body: { onboarded: true } });
  assert.equal(raw.prepare("SELECT onboarded_at FROM fan_profiles WHERE telegram_user_id=501").get().onboarded_at, first, "the first time is kept");
  assert.deepEqual((await call("/api/telegram-center-v33/me", { user: U })).body.interests, ["bets", "streams"], "only «onboarded» keeps the interests");
  assert.equal((await call("/api/telegram-center-v33/nothing")).status, 404);
  assert.equal((await call("/api/telegram-center-v33/me", { method: "DELETE", user: U })).status, 405);
}
Date.now = realNow;

// ---- 3) the routes -------------------------------------------------------------------------------------------------------------------
const script = await (await handleTelegramCenterV33(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).text();
{
  assert.match(script, /^\(function\(\)\{const __name=/);
  assert.equal((await handleTelegramCenterV33(new Request(`https://x.test${SCRIPT_PATH}`, { method: "POST" }), env, SCRIPT_PATH)).status, 405);
  assert.equal(await handleTelegramCenterV33(new Request("https://x.test/api/other"), env, "/api/other"), null);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v33-fan.js?build=33.0"));
  assert.ok(shell.indexOf("/telegram-app/v33-fan.js") > shell.indexOf("/telegram-app/v32-live.js"), "after the live layer");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).status, 200);
}

// ---- 4) the screen -------------------------------------------------------------------------------------------------------------------
const TEAMS = { ok: true, teams: [{ tri: "UTA", name_ru: "Юта Маммот", logo: "https://l.test/UTA.svg" }, { tri: "EDM", name_ru: "Эдмонтон Ойлерз", logo: "https://l.test/EDM.svg" }, { tri: "NYI", name_ru: "Нью-Йорк Айлендерс", logo: "https://l.test/NYI.svg" }, { tri: "NYR", name_ru: "Нью-Йорк Рейнджерс", logo: "https://l.test/NYR.svg" }] };
const STARS = { ok: true, tri: "UTA", players: [1, 2, 3, 4, 5, 6].map((i) => ({ player_id: 100 + i, name: `Игрок ${i}`, position: "C", goals: i, points: i + 2, games: 7, photo: `https://p.test/${i}.png` })) };
const ACH = achievementsOf({ days: 4, streams: 1, picks: 12, exact: 0, streak: 2, follows: 1 });
function makeApp({ tab = "games", me = { ok: true, onboarded: false, follows: 0, interests: [], achievements: ACH }, signedIn = true, html = "", storage = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html class="v15Light"><head></head><body><main id="view">${html}</main></body></html>`, { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const calls = [];
  const events = [];
  window.addEventListener("hoh-follows-change", () => events.push("follows"));
  if (signedIn) window.Telegram = { WebApp: { initData: "query_id=AAE&hash=x" } };
  window.HOHV15 = {
    V2: "/api/telegram-center-v2",
    state: { profile: false },
    currentTab: () => tab,
    api: async (url, opt = {}) => {
      calls.push({ url, method: opt.method || "GET", body: opt.body ? JSON.parse(opt.body) : null });
      if (url === "/api/telegram-center-v33/me" && !opt.method) return me;
      if (url === "/api/telegram-center-v33/onboarding") return TEAMS;
      if (url.endsWith("/stars")) return STARS;
      return { ok: true };
    },
  };
  window.eval(script);
  return { window, document: window.document, calls, events, F: window.HOHV33 };
}
{
  // the first visit: three steps, the follows, the interests, done
  const { window, document, calls, events, F } = makeApp();
  await F.maybeOnboard();
  await tick(30);
  const sheet = () => document.querySelector(".v33Sheet");
  assert.ok(sheet(), "a new fan in Telegram: the questions open");
  assert.deepEqual([text(sheet().querySelector(".v33Step")), text(sheet().querySelector("h3"))], ["Шаг 1 из 3", "Знакомимся! За какую команду болеете?"]);
  assert.deepEqual([...sheet().querySelectorAll(".v33Team")].map(text), ["Юта", "Эдмонтон", "Айлендерс", "Рейнджерс"], "the city is enough on a logo, the club when two share the city");
  assert.ok(sheet().querySelector("[data-v33-next]").disabled, "no team: «Дальше» waits");
  sheet().querySelector('[data-v33-team="UTA"]').click();
  sheet().querySelector("[data-v33-next]").click();
  await tick(30);
  assert.deepEqual([text(sheet().querySelector(".v33Step")), text(sheet().querySelector("h3"))], ["Шаг 2 из 3", "Любимые игроки"]);
  assert.equal(text(sheet().querySelector(".v33Player b")), "Игрок 1", "in the order of the server (the leaders first)");
  assert.equal(sheet().querySelectorAll(".v33Player").length, 6);
  for (const id of [101, 102, 103, 104, 105, 106]) sheet().querySelector(`[data-v33-player="${id}"]`).click();
  assert.equal(sheet().querySelectorAll(".v33Player.on").length, 5, "five players at most");
  sheet().querySelector('[data-v33-player="105"]').click();
  assert.equal(sheet().querySelectorAll(".v33Player.on").length, 4, "a second tap takes a player off");
  sheet().querySelector("[data-v33-next]").click();
  assert.deepEqual([text(sheet().querySelector(".v33Step")), text(sheet().querySelector("h3"))], ["Шаг 3 из 3", "Что вам интереснее?"]);
  sheet().querySelector('[data-v33-int="bets"]').click();
  sheet().querySelector('[data-v33-int="streams"]').click();
  sheet().querySelector("[data-v33-done]").click();
  await tick(60);
  assert.equal(document.querySelector(".v33Shade"), null, "closed");
  const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/telegram-center-v2/subscriptions").map((c) => c.body);
  assert.deepEqual(posts, [{ type: "team", key: "UTA" }, { type: "player", key: "101" }, { type: "player", key: "102" }, { type: "player", key: "103" }, { type: "player", key: "104" }], "the answers are the usual follows");
  assert.deepEqual(calls.find((c) => c.method === "PUT").body, { interests: ["bets", "streams"], onboarded: true });
  assert.deepEqual(events, ["follows"], "the home page reloads its follows");
  assert.equal(window.localStorage.getItem("hoh-onboard-v1"), "1");
  assert.equal(window.localStorage.getItem("hoh-interests"), '["bets","streams"]');
  assert.equal(text(document.querySelector(".v33Toast")), "Готово! Главная настроена под вас");
  window.close();
}
{
  // skipped: remembered, nothing followed; somebody who already follows: never asked; a guest: never asked
  const a = makeApp();
  await a.F.maybeOnboard();
  await tick(30);
  a.document.querySelector("[data-v33-skip]").click();
  await tick(40);
  assert.deepEqual(a.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.url, c.body]), [["POST", "/api/telegram-center-v33/activity", { kind: "open" }], ["PUT", "/api/telegram-center-v33/me", { onboarded: true }]]);
  assert.equal(a.window.localStorage.getItem("hoh-onboard-v1"), "1");
  a.window.close();
  const b = makeApp({ me: { ok: true, onboarded: false, follows: 3, interests: [], achievements: ACH } });
  await b.F.maybeOnboard();
  await tick(30);
  assert.equal(b.document.querySelector(".v33Shade"), null, "an old fan with follows is not asked");
  assert.ok(b.calls.some((c) => c.method === "PUT" && c.body.onboarded === true), "only remembered");
  b.window.close();
  const c = makeApp({ signedIn: false });
  await c.F.maybeOnboard();
  assert.equal(c.document.querySelector(".v33Shade"), null);
  assert.equal(c.calls.length, 0, "a guest: nothing asked, nothing counted");
  c.window.close();
  const d = makeApp({ storage: { "hoh-onboard-v1": "1" } });
  await d.F.maybeOnboard();
  assert.equal(d.document.querySelector(".v33Shade"), null, "done once: never again");
  d.window.close();
}
{
  // the counting: an open once a day, a broadcast, a fresh news
  const { window, document, calls } = makeApp({ storage: { "hoh-onboard-v1": "1" }, html: '<a href="https://vkvideo.ru/video-1_2">VK</a><button data-v27-news="7">Новость</button>' });
  await tick(10);
  assert.equal(calls.filter((c) => c.body && c.body.kind === "open").length, 1);
  assert.equal(window.localStorage.getItem("hoh-open-day"), new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10));
  document.querySelector("a").addEventListener("click", (e) => e.preventDefault());
  document.querySelector("a").click();
  document.querySelector("button").click();
  await tick(10);
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.body), [{ kind: "open" }, { kind: "stream" }, { kind: "news", news_id: 7 }]);
  window.close();
  const again = makeApp({ storage: { "hoh-onboard-v1": "1", "hoh-open-day": new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10) } });
  await tick(10);
  assert.equal(again.calls.filter((c) => c.body && c.body.kind === "open").length, 0, "the same day: not counted twice");
  again.window.close();
}
{
  // «Достижения» under the profile on «Мои», the best ones first; «Настроить главную» opens the questions again
  const { document, F } = makeApp({ tab: "follows", storage: { "hoh-onboard-v1": "1" }, html: '<section id="v29Me"></section>' });
  F.paint();
  await tick(200);
  const box = document.getElementById("v33Ach");
  assert.ok(box, "the card is there");
  assert.equal(box.previousElementSibling.id, "v29Me", "under the profile and the table");
  const badges = [...box.querySelectorAll(".v33Badge")];
  assert.equal(badges.length, 8);
  assert.equal(badges[0].dataset.v33Badge, "picks", "the most advanced first (2 of 4 steps)");
  const days = box.querySelector('[data-v33-badge="days"]');
  assert.equal(text(days), "📅 Каждый день с хоккеем ★☆☆☆ 4 из 7 · дней подряд в приложении");
  assert.ok(days.classList.contains("done"));
  assert.ok(!box.querySelector('[data-v33-badge="exact"]').classList.contains("done"));
  box.querySelector("[data-v33-setup]").click();
  await tick(20);
  assert.ok(document.querySelector(".v33Sheet"), "the questions can be answered again");
}
{
  // what the person likes: «Трансляции» or «Ставки» without «Результаты» → the match of the day above the goals
  const home = '<section class="v27Home"><div data-sec="goals"></div><div data-sec="hero"></div></section>';
  const up = makeApp({ storage: { "hoh-onboard-v1": "1", "hoh-interests": '["bets"]' }, html: home });
  await tick(10);
  assert.ok(up.document.querySelector(".v27Home").classList.contains("v33HeroUp"));
  assert.match(up.document.getElementById("v33css").textContent, /\.v27Home\.v33HeroUp:not\(\.v32LiveFirst\)>\[data-sec="hero"\]\{order:2!important\}/, "a live match of the day keeps the very top");
  up.window.close();
  const same = makeApp({ storage: { "hoh-onboard-v1": "1", "hoh-interests": '["results","bets"]' }, html: home });
  await tick(10);
  assert.ok(!same.document.querySelector(".v27Home").classList.contains("v33HeroUp"), "with the results the usual order");
  same.window.close();
}

console.log("fan v33 validation passed");
