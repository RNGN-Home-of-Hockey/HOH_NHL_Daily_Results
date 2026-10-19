// v37: «Вопрос недели» (the owner, 2026-10-19: «куда обменяют Ларкина… напишите по одной команде… комментаторы подсвечивались бы
// отдельно… сделаем графику с прогнозов»), the admins invited by @nick, the commentators of HOH in the cards of the games and in «Мои».
// The API and the bot run on SQLite with the tables of the real migrations; the screen in jsdom.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { SCRIPT_PATH, WEEK_XP, optionsOf, matchAnswer, parseWeek, weekPayload, handleTelegramCenterV37 } from "../cloudflare-worker/src/telegram-center-v37-week.js";
import { handleAdminMessage } from "../cloudflare-worker/src/telegram-center-admin-bot.js";
import { handleTelegramCenterV29 } from "../cloudflare-worker/src/telegram-center-v29-predictions.js";
import { weekXpOf } from "../cloudflare-worker/src/telegram-center-v29-predictions-data.js";
import { handleTelegramCenterV35 } from "../cloudflare-worker/src/telegram-center-v35-hosts.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const plain = (v) => JSON.parse(JSON.stringify(v));
const windows = []; // closed at the end: their timers would keep the test running

// ---- 1) the rules ---------------------------------------------------------------------------------------------------------------
assert.deepEqual(parseWeek("Куда обменяют Ларкина? | команда | Останется"), { text: "Куда обменяют Ларкина?", kind: "team", options: ["Останется"] });
assert.deepEqual(parseWeek("  Кто   возьмёт Кубок?  | Команды"), { text: "Кто возьмёт Кубок?", kind: "team", options: [] });
assert.deepEqual(parseWeek("Овечкин сыграет 1000-й матч? | Да; Нет; Не знаю"), { text: "Овечкин сыграет 1000-й матч?", kind: "options", options: ["Да", "Нет", "Не знаю"] });
assert.equal(parseWeek("Вопрос без вариантов?"), null, "the kind of the answer is required");
assert.equal(parseWeek("Да? | Да"), null, "too short, and one variant is not a question");
assert.equal(parseWeek("Сыграет ли он? | Да; да"), null, "the same variant twice");
assert.equal(parseWeek(`Вопрос недели? | ${Array.from({ length: 9 }, (_, i) => `в${i}`).join(";")}`), null, "up to 8 variants");
assert.equal(parseWeek(`${"x".repeat(201)} | Да; Нет`), null, "up to 200 letters");
const TQ = { kind: "team", options_json: JSON.stringify(["Останется"]) };
const opts = optionsOf(TQ);
assert.equal(opts.length, 33, "32 teams and «Останется»");
assert.deepEqual(plain(opts.slice(0, 2)), [{ key: "NYI", label: "Айлендерс", logo: "https://assets.nhle.com/logos/nhl/svg/NYI_light.svg" }, { key: "ANA", label: "Анахайм", logo: "https://assets.nhle.com/logos/nhl/svg/ANA_light.svg" }], "the teams by their short Russian names");
assert.deepEqual(plain(opts.at(-1)), { key: "x1", label: "Останется" });
assert.equal(matchAnswer(TQ, "Миннесота"), "MIN");
assert.equal(matchAnswer(TQ, "sjs"), "SJS");
assert.equal(matchAnswer(TQ, "сан хосе"), "SJS");
assert.equal(matchAnswer(TQ, "Миннесота Уайлд"), "MIN", "the full name of the club");
assert.equal(matchAnswer(TQ, "останется"), "x1");
assert.equal(matchAnswer(TQ, "Нью"), "NJD", "the only club that starts so");
assert.equal(matchAnswer(TQ, "Ва"), null, "Ванкувер or Вашингтон — not sure: nothing");
assert.equal(matchAnswer(TQ, "Мухосранск"), null);
const OQ = { kind: "options", options_json: JSON.stringify(["Да", "Нет"]) };
assert.deepEqual(plain(optionsOf(OQ)), [{ key: "o1", label: "Да" }, { key: "o2", label: "Нет" }]);
assert.equal(matchAnswer(OQ, "нет"), "o2");
{
  const q = { question_id: 7, text: "Куда?", kind: "team", options_json: "[]", status: "open", created_at: "2026-10-19 10:00:00" };
  const counts = [{ answer: "MIN", n: 3 }, { answer: "SJS", n: 1 }];
  const people = [{ id: 1, name: "Андрей Протасов", answer: "SJS" }, { id: 2, name: "Михаил Камнев", answer: "MIN" }];
  const guest = weekPayload(q, counts, people, null, false).question;
  assert.deepEqual([guest.total, guest.results, guest.commentators, guest.commentators_total], [4, null, null, 2], "before one's own answer: how many, not who");
  const me = weekPayload(q, counts, people, "MIN", true);
  assert.equal(me.admin, true);
  assert.equal(me.question.right, null, "no right or wrong before the answer is known");
  assert.deepEqual(plain(me.question.results.map((r) => [r.key, r.count, r.pct, r.commentators.map((c) => c.name)])), [["MIN", 3, 75, ["Михаил Камнев"]], ["SJS", 1, 25, ["Андрей Протасов"]]]);
  assert.deepEqual(plain(me.question.commentators), [{ id: 1, name: "Андрей Протасов", answer: "SJS", label: "Сан-Хосе" }, { id: 2, name: "Михаил Камнев", answer: "MIN", label: "Миннесота" }]);
  assert.ok(weekPayload({ ...q, status: "closed" }, counts, people, null, false).question.results, "a closed question shows the split to everybody");
  const settled = weekPayload({ ...q, status: "settled", answer: "MIN" }, counts, people, "MIN", false).question;
  assert.deepEqual([settled.answer, settled.answer_label, settled.right, settled.xp], ["MIN", "Миннесота", true, WEEK_XP]);
  const wrong = weekPayload({ ...q, status: "settled", answer: "MIN" }, counts, people, "SJS", false).question;
  assert.deepEqual([wrong.right, wrong.xp], [false, null]);
  assert.equal(weekPayload(null, [], [], null, true).question, null);
}

// ---- 2) the API and the bot on SQLite ---------------------------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => migration(file).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
for (const t of ["teams", "games", "telegram_users", "winline_events", "winline_markets"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(createOf("0018_winline_market_snapshots.sql", "winline_market_snapshots"));
for (const f of ["0048_fan_predictions.sql", "0050_fan_prediction_scores.sql", "0052_fan_streaks_privacy.sql", "0049_player_names_admin.sql", "0055_hosts_questions.sql", "0059_week_questions.sql"]) raw.exec(migration(f));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const TOKEN = "123456:TEST";
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } }, TELEGRAM_CENTER_BOT_TOKEN: TOKEN };
const NOW = Date.now();
const initDataFor = (user) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), query_id: "AAE", user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
};
const call = async (handler, path, { method = "GET", user = null, body } = {}) => {
  const headers = {};
  if (user) headers["X-Telegram-Init-Data"] = initDataFor(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handler(new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, path.split("?")[0]);
  return { status: res.status, body: await res.json() };
};
const week = (opt) => call(handleTelegramCenterV37, "/api/telegram-center-v37/week", opt);
const ADMIN = 9500, FAN = { id: 9101, first_name: "Фан", username: "fan_one" }, FAN2 = { id: 9102, first_name: "Два" };
for (const [id, nick] of [[ADMIN, "boss"], [9101, "fan_one"], [9102, null]]) raw.prepare("INSERT INTO telegram_users(telegram_user_id,first_name,username) VALUES(?,?,?)").run(id, "U", nick);
raw.prepare("INSERT INTO app_admins(telegram_user_id,note) VALUES(?,?)").run(ADMIN, "owner");
// the commentators of the chat: in app_hosts without having opened the bot (taken from the chat by their Telegram ids)
for (const [id, name] of [[7001, "Андрей Протасов"], [7002, "Михаил Камнев"], [7003, "Илья Бобров"], [7004, "Андрей Юртаев"]]) raw.prepare("INSERT INTO app_hosts(telegram_user_id,display_name,added_by) VALUES(?,?,?)").run(id, name, ADMIN);
const sent = [];
const bot = (from, msg, username) => handleAdminMessage(env, { from: { id: from, username }, chat: { id: from, type: "private" }, text: msg }, async (m) => { sent.push(m.text); });
{
  assert.deepEqual((await week()).body, { ok: true, question: null, admin: false }, "no question yet");
  // the admin asks
  assert.deepEqual(await bot(ADMIN, "/week Куда?"), { handled: true });
  assert.match(sent.pop(), /Напишите так:\n«Вопрос недели» в приложении:/, "the format when the question is wrong");
  await bot(ADMIN, "/week Старый вопрос недели? | Да; Нет");
  await bot(ADMIN, "/week Куда обменяют Ларкина? | команда | Останется");
  assert.match(sent.pop(), /^Вопрос недели #2 в приложении ✅\n«Куда обменяют Ларкина\?»\nОтвет: любая команда НХЛ или: Останется/);
  assert.equal(raw.prepare("SELECT status FROM week_questions WHERE question_id=1").get().status, "closed", "a new question closes the old one");
  // the commentators' answers typed in from the chat
  await bot(ADMIN, "/week_answer Протасов = Сан-Хосе");
  assert.equal(sent.pop(), "🎙 Андрей Протасов — Сан-Хосе ✅");
  await bot(ADMIN, "/week_answer Камнев = MIN");
  assert.equal(sent.pop(), "🎙 Михаил Камнев — Миннесота ✅");
  await bot(ADMIN, "/week_answer Андрей = Вегас");
  assert.match(sent.pop(), /Под «Андрей» подходят: (Андрей Протасов, Андрей Юртаев|Андрей Юртаев, Андрей Протасов)/, "two Андрей: ask to be precise");
  await bot(ADMIN, "/week_answer Петров = Вегас");
  assert.match(sent.pop(), /Комментатора «Петров» нет в списке/);
  await bot(ADMIN, "/week_answer Бобров = Мухосранск");
  assert.match(sent.pop(), /Не понял ответ «Мухосранск»/);
  // a guest: the question, the variants, how many commentators answered — not who
  const g = (await week()).body.question;
  assert.deepEqual([g.id, g.text, g.status, g.total, g.options.length, g.results, g.commentators, g.commentators_total], [2, "Куда обменяют Ларкина?", "open", 2, 33, null, null, 2]);
  // a fan answers
  assert.equal((await week({ method: "POST", body: { question_id: 2, answer: "MIN" } })).status, 401, "a guest cannot answer");
  assert.equal((await week({ method: "POST", user: FAN, body: { question_id: 2, answer: "XXX" } })).status, 400);
  assert.equal((await week({ method: "POST", user: FAN, body: { question_id: 1, answer: "o1" } })).status, 409, "the old question is closed");
  const a1 = await week({ method: "POST", user: FAN, body: { question_id: 2, answer: "MIN" } });
  assert.equal(a1.status, 200);
  assert.deepEqual(plain(a1.body.question.results.map((r) => [r.key, r.count, r.pct, r.commentators.map((c) => c.name)])), [["MIN", 2, 67, ["Михаил Камнев"]], ["SJS", 1, 33, ["Андрей Протасов"]]]);
  assert.equal(a1.body.question.my, "MIN");
  await week({ method: "POST", user: FAN2, body: { question_id: 2, answer: "x1" } });
  await week({ method: "POST", user: FAN, body: { question_id: 2, answer: "SJS" } });
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM week_answers WHERE question_id=2").get().n, 4, "one answer per person, the last one counts");
  assert.equal((await week({ user: FAN })).body.question.my, "SJS");
  assert.equal((await week({ user: { id: ADMIN, first_name: "B" } })).body.admin, true, "the admin sees «Картинка для соцсетей»");
  // the stats in the bot
  await bot(ADMIN, "/week_stats");
  assert.match(sent.pop(), /«Куда обменяют Ларкина\?» \(идут ответы\)\nОтветов: 4\nСан-Хосе — 2 \(50%\) · 🎙 Андрей Протасов\nМиннесота — 1 \(25%\) · 🎙 Михаил Камнев\nОстанется — 1 \(25%\)/);
  // closed, then the answer is known
  await bot(ADMIN, "/week_close");
  assert.match(sent.pop(), /Ответы на «Куда обменяют Ларкина\?» закрыты/);
  assert.equal((await week({ method: "POST", user: FAN, body: { question_id: 2, answer: "MIN" } })).status, 409);
  assert.ok((await week()).body.question.results, "closed: the split for everybody");
  await bot(ADMIN, "/week_result Сан-Хосе");
  assert.equal(sent.pop(), `Ответ: Сан-Хосе ✅ Угадали 2 из 4, им +${WEEK_XP} XP.`);
  const s = (await week({ user: FAN })).body.question;
  assert.deepEqual([s.status, s.answer_label, s.right, s.xp], ["settled", "Сан-Хосе", true, WEEK_XP]);
  assert.equal((await week({ user: FAN2 })).body.question.right, false);
  assert.deepEqual([await weekXpOf(env.DB, 9101), await weekXpOf(env.DB, 7001), await weekXpOf(env.DB, 9102)], [WEEK_XP, WEEK_XP, 0], "the XP for the level");
  // hidden
  await bot(ADMIN, "/week_hide");
  assert.equal((await week()).body.question, null);
  // a non-admin: the commands are not his
  assert.deepEqual(await bot(9101, "/week Мой вопрос? | Да; Нет", "fan_one"), { handled: false });
}

// ---- 3) the admins invited by @nick (Ваня has not opened the bot yet) -------------------------------------------------------------
{
  await bot(ADMIN, "/admin_add @Bublik_Test");
  assert.equal(sent.pop(), "@Bublik_Test ещё не открывал бота. Как только он напишет этому боту /admin, он станет админом ✅");
  assert.equal(raw.prepare("SELECT username FROM app_admin_invites").get().username, "bublik_test");
  await bot(ADMIN, "/admins");
  assert.match(sent.pop(), /Ждём, когда откроют бота: @bublik_test/);
  assert.deepEqual(await bot(9900, "/admin", "someone_else"), { handled: false }, "another account gets nothing");
  assert.deepEqual(await bot(9901, "привет", "Bublik_Test"), { handled: false }, "not an admin command: nothing happens");
  assert.deepEqual(await bot(9901, "/admin", "Bublik_Test"), { handled: true }, "the first admin command makes him an admin");
  assert.match(sent.pop(), /🛠 Команды админа/);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_admins WHERE telegram_user_id=9901").get().n, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM app_admin_invites").get().n, 0, "the invite is used up");
  assert.deepEqual(await bot(9901, "/week_stats", "Bublik_Test"), { handled: true }, "and the question of the week is his now");
  sent.length = 0;
}

// ---- 4) the commentators in the cards of the games and in «Мои» --------------------------------------------------------------------
{
  for (const tri of ["UTA", "EDM", "NYR", "TBL"]) raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(tri, tri);
  const start = new Date(NOW + 5 * 3600000).toISOString();
  raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score) VALUES(?,?,?,?,?,?,?,?,?)").run(300, "20262027", 2, start, "FUT", "EDM", "UTA", 0, 0);
  // the commentators who vote in the app have opened it: they are fans too
  for (const id of [7001, 7002, 7003]) raw.prepare("INSERT INTO telegram_users(telegram_user_id,first_name) VALUES(?,?)").run(id, "C");
  const pick = raw.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,game_date,season_id) VALUES(?,?,?,?,?,?)");
  pick.run(7001, 300, "away", "UTA", start.slice(0, 10), "20262027");
  pick.run(7002, 300, "home", "EDM", start.slice(0, 10), "20262027");
  pick.run(7003, 300, "home", "EDM", start.slice(0, 10), "20262027");
  const v29 = (opt) => call(handleTelegramCenterV29, "/api/telegram-center-v29/games?ids=300", opt);
  assert.deepEqual(plain((await v29()).body.games[0].hosts), { total: 3, list: null }, "before one's own pick: only how many commentators voted");
  pick.run(9101, 300, "home", "EDM", start.slice(0, 10), "20262027");
  assert.deepEqual(plain((await v29({ user: FAN })).body.games[0].hosts), { total: 3, list: [{ id: 7001, name: "Андрей Протасов", pick: "away" }, { id: 7003, name: "Илья Бобров", pick: "home" }, { id: 7002, name: "Михаил Камнев", pick: "home" }] }, "after it: who is for whom");
  raw.prepare("UPDATE app_hosts SET active=0 WHERE telegram_user_id=7003").run();
  assert.equal((await v29({ user: FAN })).body.games[0].hosts.total, 2, "a commentator who was removed is not shown");
  raw.prepare("UPDATE app_hosts SET active=1 WHERE telegram_user_id=7003").run();
  // «Мои»: only the commentators who made picks are listed (the whole chat is in app_hosts)
  const hosts = await call(handleTelegramCenterV35, "/api/telegram-center-v35/hosts");
  assert.deepEqual(hosts.body.hosts.map((h) => h.name).sort(), ["Андрей Протасов", "Илья Бобров", "Михаил Камнев"], "Юртаев has no picks: not listed");
}

// ---- 5) the routes -------------------------------------------------------------------------------------------------------------
{
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v37-week.js?build=37.0"), "the script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v37-week.js") > shell.indexOf("/telegram-app/v35-hosts.js"), "after the commentators");
  const script = await (await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).text();
  assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
  assert.equal((await handleTeamCurrentRequest(new Request("https://x.test/api/telegram-center-v37/week"), {}, "/api/telegram-center-v37/week")).status, 503, "the API through the main router (no database here)");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(`<svg data-url="${url}"></svg>`, { status: 200 });
  const logo = await handleTelegramCenterV37(new Request("https://x.test/api/telegram-center-v37/logo/MIN.svg"), {}, "/api/telegram-center-v37/logo/MIN.svg");
  assert.equal(logo.headers.get("content-type"), "image/svg+xml");
  assert.match(await logo.text(), /MIN_light\.svg/, "the official logo from our address");
  assert.equal((await handleTelegramCenterV37(new Request("https://x.test/api/telegram-center-v37/logo/XYZ.svg"), {}, "/api/telegram-center-v37/logo/XYZ.svg")).status, 404);
  globalThis.fetch = realFetch;
}

// ---- 6) the screen ---------------------------------------------------------------------------------------------------------------
const SCRIPT = await (await handleTelegramCenterV37(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).text();
function makeApp({ tab = "games", signedIn = true, admin = false, question, html } = {}) {
  const dom = new JSDOM(`<!doctype html><html class="v15Light"><body><main id="view">${html ?? '<section class="v27Home"><div class="v27Sec" data-sec="strip" style="order:2"></div><div class="v27Sec" data-sec="hero" style="order:3"><article class="v27Hero"></article></div><div class="v27Sec" data-sec="goals" style="order:4"></div></section>'}</main></body></html>`, { url: "https://x.test/telegram-app", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  windows.push(window);
  window.HTMLCanvasElement.prototype.getContext = () => null; // no canvas in jsdom (quietly)
  const box = { calls: [], q: question ? JSON.parse(JSON.stringify(question)) : null };
  if (signedIn) window.Telegram = { WebApp: { initData: "query_id=AAE&hash=x" } };
  window.HOHAuth = { signedIn: () => signedIn, needLogin: (t) => `<div class="hohNeedLogin"><p>${t}</p><button>Войти через Telegram</button></div>` };
  window.HOHV15 = {
    state: { profile: false },
    currentTab: () => tab,
    api: async (url, opt = {}) => {
      box.calls.push({ url, method: opt.method || "GET", body: opt.body ? JSON.parse(opt.body) : null });
      if (opt.method === "POST") {
        const b = JSON.parse(opt.body);
        box.q.my = b.answer;
        box.q.total += 1;
        box.q.commentators = [{ id: 7001, name: "Андрей Протасов", answer: "SJS", label: "Сан-Хосе" }];
        box.q.results = [{ key: b.answer, label: "Миннесота", logo: "https://l.test/MIN.svg", count: 2, pct: 67, commentators: [] }, { key: "SJS", label: "Сан-Хосе", logo: "https://l.test/SJS.svg", count: 1, pct: 33, commentators: [{ id: 7001, name: "Андрей Протасов" }] }];
      }
      return { ok: true, admin, question: box.q };
    },
  };
  window.eval(SCRIPT);
  return { window, document: window.document, box, V: window.HOHV37 };
}
const OPEN = { id: 2, text: "Куда обменяют Ларкина?", kind: "team", status: "open", total: 4, answer: null, answer_label: null, options: plain(optionsOf(TQ)), commentators_total: 2, commentators: null, results: null, my: null, right: null, xp: null };
{
  // the home: under the match of the day, in its order
  const { document, box } = makeApp({ question: OPEN });
  await tick(60);
  const card = document.getElementById("v37Week");
  assert.ok(card, "the card of the question");
  assert.equal(card.previousElementSibling.dataset.sec, "hero", "right under the match of the day");
  assert.equal(card.style.order, "3", "in the order of the hero");
  assert.equal(text(card.querySelector(".v37Tag")), "🗳 ВОПРОС НЕДЕЛИ");
  assert.equal(text(card.querySelector(".v37Count")), "4 ответа");
  assert.equal(text(card.querySelector(".v37Q")), "Куда обменяют Ларкина?");
  assert.match(text(card.querySelector("[data-v37-teaser]")), /Ответили комментаторы HOH: 2 — их выбор после вашего ответа/);
  assert.ok(!card.querySelector(".v37Grid"), "the 32 logos wait for a tap");
  card.querySelector("[data-v37-open]").click();
  await tick(20);
  assert.equal(document.querySelectorAll("#v37Week .v37Grid .v37Team").length, 32);
  assert.equal(document.querySelector('#v37Week [data-v37-answer="MIN"] img').getAttribute("src"), "https://assets.nhle.com/logos/nhl/svg/MIN_light.svg");
  assert.equal(text(document.querySelector('#v37Week .v37Var[data-v37-answer="x1"]')), "Останется");
  document.querySelector('#v37Week [data-v37-answer="MIN"]').click();
  await tick(30);
  assert.deepEqual(box.calls.filter((c) => c.method === "POST").map((c) => c.body), [{ question_id: 2, answer: "MIN" }]);
  const after = document.getElementById("v37Week");
  assert.deepEqual([...after.querySelectorAll(".v37Row")].map((r) => [r.dataset.v37Row, text(r.querySelector("strong")), r.classList.contains("mine")]), [["MIN", "67%", true], ["SJS", "33%", false]]);
  assert.equal(text(after.querySelector('[data-v37-row="SJS"] small')), "🎙 Протасов", "the commentators by the answer");
  assert.equal(text(after.querySelector("[data-v37-hosts]")), "🎙 Комментаторы HOH 🎙Андрей Протасов — Сан-Хосе");
  assert.ok(after.querySelector("[data-v37-change]"), "the answer can be changed while the question is open");
  assert.ok(!after.querySelector("[data-v37-picture]"), "the picture is for the admins");
  after.querySelector("[data-v37-change]").click();
  await tick(20);
  assert.ok(document.querySelector("#v37Week .v37Grid"), "the logos again");
  assert.ok(document.querySelector('#v37Week [data-v37-answer="MIN"]').classList.contains("mine"), "the answer is marked");
}
{
  // a guest: the sign-in instead of the answer
  const { document, box } = makeApp({ question: OPEN, signedIn: false });
  await tick(60);
  document.querySelector("[data-v37-open]").click();
  await tick(20);
  document.querySelector('#v37Week [data-v37-answer="EDM"]').click();
  await tick(20);
  assert.equal(box.calls.filter((c) => c.method === "POST").length, 0);
  assert.match(text(document.querySelector("#v37Week .hohNeedLogin")), /Войдите через Telegram, чтобы ответить на вопрос недели/);
}
{
  // «Мои», an admin, a question with the answer known
  const settled = { ...OPEN, status: "settled", answer: "SJS", answer_label: "Сан-Хосе", my: "SJS", right: true, xp: 30, total: 6, commentators: [{ id: 7001, name: "Андрей Протасов", answer: "SJS", label: "Сан-Хосе" }], results: [{ key: "SJS", label: "Сан-Хосе", logo: "x", count: 4, pct: 67, commentators: [{ id: 7001, name: "Андрей Протасов" }] }, { key: "MIN", label: "Миннесота", logo: "y", count: 1, pct: 17, commentators: [] }, { key: "x1", label: "Останется", logo: null, count: 1, pct: 17, commentators: [] }] };
  const { document, V } = makeApp({ tab: "follows", admin: true, question: settled, html: '<section id="v29Me"></section><section id="v35Hosts"></section>' });
  await tick(60);
  const card = document.getElementById("v37Week");
  assert.equal(card.previousElementSibling.id, "v35Hosts", "under the commentators");
  assert.equal(text(card.querySelector(".v37Line")), "Ответ: Сан-Хосе · ✅ Вы угадали! +30 XP");
  assert.ok(card.querySelector('[data-v37-row="SJS"]').classList.contains("right"));
  assert.equal(text(card.querySelector('[data-v37-row="x1"] .v37Dot')), "О", "a variant without a logo");
  assert.ok(!card.querySelector("[data-v37-change]"), "no changes once the answer is known");
  assert.ok(card.querySelector("[data-v37-picture]"), "the admin gets the picture");
  assert.equal(await V.picture(), null, "no canvas in this test browser: no picture");
  card.querySelector("[data-v37-picture]").click();
  await tick(30);
  assert.equal(text(document.querySelector("#v37Week .v37Note")), "Не получилось нарисовать картинку");
}
{
  // no question: no card; a player's page: no card
  const none = makeApp({ question: null });
  await tick(60);
  assert.equal(none.document.getElementById("v37Week"), null);
  const inside = makeApp({ question: OPEN });
  await tick(60);
  inside.window.HOHV15.state.profile = true;
  inside.V.paint(true);
  assert.equal(inside.document.getElementById("v37Week"), null, "inner pages keep their own content");
}

// ---- 7) the commentators in the cards (v29 screen) ---------------------------------------------------------------------------------
{
  const { predictionsApp } = await import("../cloudflare-worker/src/telegram-center-v29-predictions-ui.js");
  const dom = new JSDOM('<!doctype html><html class="v15Light"><body><main id="view"></main></body></html>', { url: "https://x.test/telegram-app", runScripts: "outside-only" });
  const { window } = dom;
  windows.push(window);
  window.HOHV15 = { esc: (v) => String(v), state: { profile: false }, currentTab: () => "games", tabsVisible: () => true, view: () => window.document.getElementById("view"), api: async () => ({ ok: true, games: [] }) };
  window.eval(`(function(){const __name=(t)=>t;(${predictionsApp.toString()})();})();`);
  const S = window.HOHV29;
  const team = (tri) => ({ tri, name_ru: tri, logo: "" });
  const g = (extra) => ({ game_pk: 1, start: new Date(NOW + 3600000).toISOString(), open: true, away: team("UTA"), home: team("EDM"), votes: { total: 3, home: null, away: null }, my: null, settled: null, ...extra });
  const html = (game) => { const d = window.document.createElement("div"); d.innerHTML = S.voteHtml(game, "card"); return d; };
  assert.equal(text(html(g({ hosts: { total: 3, list: null } })).querySelector("[data-v29-hosts]")), "🎙Проголосовали комментаторы HOH: 3 — их выбор после вашего голоса");
  const list = [{ id: 1, name: "Андрей Протасов", pick: "away" }, { id: 2, name: "Михаил Камнев", pick: "home" }, { id: 3, name: "Илья Бобров", pick: "home" }, { id: 4, name: "А Б", pick: "home" }, { id: 5, name: "В Г", pick: "home" }];
  assert.equal(text(html(g({ open: false, my: { pick: "home" }, votes: { total: 3, home: 2, away: 1 }, hosts: { total: 5, list } })).querySelector("[data-v29-hosts]")), "🎙Комментаторы за UTA: Протасов · за EDM: Камнев, Бобров, Б +1", "who is for whom, three names and the rest counted");
  assert.equal(html(g({ hosts: { total: 0, list: null } })).querySelector("[data-v29-hosts]"), null, "nobody voted: nothing");
  window.HOHNoSpoilers = () => true;
  assert.equal(html(g({ open: false, hosts: { total: 2, list: list.slice(0, 2) }, settled: { winner: "home" } })).querySelector("[data-v29-hosts]"), null, "the no-spoilers mode hides them after the start");
}

for (const w of windows) w.close();
console.log("week v37 validation passed");
