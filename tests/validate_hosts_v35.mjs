// v35: the hosts of Home of Hockey (public picks, «Сравнить со мной», «Зрители против ведущих») and «Задай вопрос комментаторам», with
// the commands of the admins in the bot. The API and the bot run on SQLite with the tables of the real migrations; the screen in jsdom.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { SCRIPT_PATH, QUESTIONS_PER_DAY, contestOf, cleanQuestion, handleTelegramCenterV35 } from "../cloudflare-worker/src/telegram-center-v35-hosts.js";
import { handleAdminMessage } from "../cloudflare-worker/src/telegram-center-admin-bot.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- 1) the rules ---------------------------------------------------------------------------------------------------------------
assert.equal(contestOf([], [1]), null);
assert.equal(contestOf([{ id: 1, settled: 3, correct: 2 }], []), null, "no hosts: no contest");
const c = contestOf([
  { id: 1, settled: 4, correct: 3 }, // a host
  { id: 2, settled: 5, correct: 3 }, { id: 3, settled: 3, correct: 3 }, // fans with 3+ picks
  { id: 4, settled: 2, correct: 2 }, // a fan with too few picks: out
], [1]);
assert.deepEqual(c, { fans: { accuracy: 75, players: 2 }, hosts: { accuracy: 75, players: 1 }, leader: "draw" }, "6 of 8 against 3 of 4");
assert.equal(contestOf([{ id: 1, settled: 2, correct: 0 }, { id: 2, settled: 3, correct: 3 }], [1]).leader, "fans");
assert.equal(cleanQuestion("  Почему   Капризов   не играет в меньшинстве?  "), "Почему Капризов не играет в меньшинстве?");
assert.equal(cleanQuestion("Ок"), null, "too short");
assert.equal(cleanQuestion("x".repeat(301)), null, "too long");

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
raw.exec(migration("0049_player_names_admin.sql"));
raw.exec(migration("0055_hosts_questions.sql"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const TOKEN = "123456:TEST";
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } }, TELEGRAM_CENTER_BOT_TOKEN: TOKEN };
const NOW = Date.parse("2026-10-15T09:00:00Z"); // Thursday: the week is 12–18 October
const initDataFor = (user) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), query_id: "AAE", user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
};
const realNow = Date.now;
Date.now = () => NOW;
const call = async (path, { method = "GET", user = null, body } = {}) => {
  const headers = {};
  if (user) headers["X-Telegram-Init-Data"] = initDataFor(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handleTelegramCenterV35(new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, path.split("?")[0]);
  return { status: res.status, body: await res.json() };
};
const FAN = { id: 9101, first_name: "Фан", username: "fan_one" };
const ADMIN = 9500;
{
  for (const [id, nick] of [[9001, "host_one"], [9002, "host_two"], [9101, "fan_one"], [9102, "fan_two"], [ADMIN, "boss"]]) raw.prepare("INSERT INTO telegram_users(telegram_user_id,first_name,username) VALUES(?,?,?)").run(id, "U", nick);
  raw.prepare("INSERT INTO app_admins(telegram_user_id,note) VALUES(?,?)").run(ADMIN, "owner");
  for (const tri of ["UTA", "EDM", "NYR", "TBL"]) raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(tri, tri);
  const game = raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri,home_score,away_score) VALUES(?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 4; i++) game.run(100 + i, "20262027", 2, `2026-10-1${2 + (i % 3)}T23:00:00Z`, "OFF", "NYR", "TBL", 4, 1);
  game.run(200, "20262027", 2, "2026-10-16T01:00:00Z", "FUT", "EDM", "UTA", 0, 0); // tonight
  const pick = raw.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,game_date,season_id,result,xp,settled_at) VALUES(?,?,?,?,?,?,?,?,?)");
  // the host: 3 of 4 right this week; the fans: 9101 4 of 4, 9102 1 of 4 → 5 of 8
  for (let i = 0; i < 4; i++) {
    const day = `2026-10-1${2 + (i % 3)}`;
    pick.run(9001, 100 + i, i === 3 ? "away" : "home", i === 3 ? "TBL" : "NYR", day, "20262027", i === 3 ? "loss" : "win", i === 3 ? 1 : 11, "x");
    pick.run(9101, 100 + i, "home", "NYR", day, "20262027", "win", 11, "x");
    pick.run(9102, 100 + i, i ? "away" : "home", i ? "TBL" : "NYR", day, "20262027", i ? "loss" : "win", i ? 1 : 11, "x");
  }
  raw.prepare("INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,game_date,season_id) VALUES(?,?,?,?,?,?)").run(9001, 200, "away", "UTA", "2026-10-15", "20262027");

  // the bot: the admin makes a host
  const sent = [];
  const bot = (from, msg) => handleAdminMessage(env, { from: { id: from }, chat: { id: from, type: "private" }, text: msg }, async (m) => { sent.push(m.text); });
  assert.deepEqual(await bot(9101, "/host_add @fan_one Хитрый Фан"), { handled: false }, "not an admin: the command is not taken");
  await bot(ADMIN, "/host_add @host_one Иван Ведущий");
  assert.match(sent.pop(), /Иван Ведущий \(@host_one\) теперь комментатор HOH 🎙/);
  await bot(ADMIN, "/host_add @nobody Кто-то");
  assert.match(sent.pop(), /@nobody ещё не запускал бота/);
  await bot(ADMIN, "/host_add host_two");
  assert.match(sent.pop(), /Напишите так: \/host_add @ник Имя Фамилия/);
  await bot(ADMIN, "/host_add @host_two Пётр Второй");
  await bot(ADMIN, "/host_remove @host_two");
  assert.match(sent.pop(), /@host_two больше не показывается как комментатор/);
  await bot(ADMIN, "/hosts");
  assert.equal(sent.pop(), "Комментаторы HOH:\n• Иван Ведущий (@host_one)\n• Пётр Второй (@host_two) — скрыт");
  await bot(ADMIN, "/admin");
  assert.match(sent.pop(), /\/host_add @ник Имя Фамилия[\s\S]*\/questions[\s\S]*\/ama/, "the help lists the new commands");

  // the hosts on the screen: the active ones, their numbers, their picks of tonight, the contest of the week
  const h = await call("/api/telegram-center-v35/hosts");
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.hosts.map((x) => [x.id, x.name, x.settled, x.correct, x.accuracy]), [[9001, "Иван Ведущий", 4, 3, 75]], "the hidden host is not shown");
  assert.deepEqual(h.body.hosts[0].picks, [{ tri: "UTA", game: "UTA — EDM", start: "2026-10-16T01:00:00Z" }], "what the host picked for tonight");
  assert.deepEqual(h.body.contest, { fans: { accuracy: 63, players: 2 }, hosts: { accuracy: 75, players: 1 }, leader: "hosts" });
  assert.deepEqual(h.body.week, { from: "2026-10-12", to: "2026-10-18" });

  // «Сравнить со мной»
  assert.equal((await call("/api/telegram-center-v35/hosts/9001/compare")).status, 401);
  assert.equal((await call("/api/telegram-center-v35/hosts/9002/compare", { user: FAN })).status, 404, "a hidden host cannot be compared");
  const cmp = (await call("/api/telegram-center-v35/hosts/9001/compare", { user: FAN })).body;
  assert.deepEqual(plain(cmp), { ok: true, host: { id: 9001, name: "Иван Ведущий", settled: 4, correct: 3, accuracy: 75, xp: 34 }, me: { settled: 4, correct: 4, accuracy: 100, xp: 44 }, common: 4, agree: 3 });

  // «Задай вопрос комментаторам»
  assert.equal((await call("/api/telegram-center-v35/questions", { method: "POST", body: { text: "Вопрос без входа" } })).status, 401);
  assert.equal((await call("/api/telegram-center-v35/questions", { method: "POST", user: FAN, body: { text: "Ок" } })).status, 400);
  // the fan of level 1 asks first: the level, not the time, puts the other question higher
  const q0 = await call("/api/telegram-center-v35/questions", { method: "POST", user: { id: 9102, first_name: "U", username: "fan_two" }, body: { text: "Будет ли Овечкин играть до 45?" } });
  assert.deepEqual(q0.body, { ok: true, level: 1 }, "14 XP: level 1");
  const q1 = await call("/api/telegram-center-v35/questions", { method: "POST", user: FAN, body: { text: "Кто лучший вратарь сезона?" } });
  assert.deepEqual(q1.body, { ok: true, level: 2 }, "44 XP: level 2");
  await call("/api/telegram-center-v35/questions", { method: "POST", user: FAN, body: { text: "Второй вопрос от того же" } });
  await call("/api/telegram-center-v35/questions", { method: "POST", user: FAN, body: { text: "Третий вопрос от того же" } });
  assert.equal((await call("/api/telegram-center-v35/questions", { method: "POST", user: FAN, body: { text: "Четвёртый за день" } })).status, 429, `${QUESTIONS_PER_DAY} a day`);

  // the admin sees them, the higher level first, and marks them
  await bot(ADMIN, "/questions");
  const list = sent.pop();
  assert.match(list, /^Вопросы болельщиков/);
  assert.ok(list.indexOf("Кто лучший вратарь сезона?") < list.indexOf("Будет ли Овечкин играть до 45?"), "level 2 before level 1");
  const id = Number(/#(\d+) · ур\. 2 · @fan_one\nКто лучший вратарь/.exec(list)[1]);
  await bot(ADMIN, `/q_pick ${id}`);
  assert.match(sent.pop(), new RegExp(`Вопрос #${id}: выбран для эфира ✅`));
  const other = Number(/#(\d+) · ур\. 1 · @fan_two\nБудет ли Овечкин/.exec(list)[1]);
  await bot(ADMIN, `/q_hide ${other}`);
  await bot(ADMIN, "/q_done 999");
  assert.equal(sent.pop(), "Вопроса #999 нет.");
  await bot(ADMIN, "/questions");
  assert.match(sent.pop(), new RegExp(`^Вопросы болельщиков[^#]*#${id} · ур\\. 2 · ✅ выбран`), "the picked one on top");
  await bot(ADMIN, "/ama 20 октября, 19:00 — эфир с ответами");
  assert.match(sent.pop(), /Ответы в эфире: 20 октября, 19:00/);
  const mine = (await call("/api/telegram-center-v35/questions", { user: FAN })).body;
  assert.equal(mine.ama, "20 октября, 19:00 — эфир с ответами");
  assert.deepEqual(mine.questions.map((q) => q.status), ["new", "new", "picked"], "the newest first, the picked one with its status");
  assert.ok(!(await call("/api/telegram-center-v35/questions", { user: { id: 9102, first_name: "U", username: "fan_two" } })).body.questions.length, "a hidden question is not shown to its author either");
  await bot(ADMIN, "/ama -");
  assert.equal((await call("/api/telegram-center-v35/questions", { user: FAN })).body.ama, null);
  assert.equal((await call("/api/telegram-center-v35/nothing")).status, 404);
  assert.equal((await call("/api/telegram-center-v35/hosts", { method: "POST" })).status, 405);
}
Date.now = realNow;

// ---- 3) the routes ----------------------------------------------------------------------------------------------------------------
const script = await (await handleTelegramCenterV35(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).text();
{
  assert.match(script, /^\(function\(\)\{const __name=/);
  assert.equal(await handleTelegramCenterV35(new Request("https://x.test/api/other"), env, "/api/other"), null);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v35-hosts.js?build=35.1"));
  assert.ok(shell.indexOf("/telegram-app/v35-hosts.js") > shell.indexOf("/telegram-app/v34-recap.js"));
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).status, 200);
}

// ---- 4) the screen ----------------------------------------------------------------------------------------------------------------
const HOSTS = { ok: true, hosts: [{ id: 9001, name: "Иван Ведущий", settled: 4, correct: 3, accuracy: 75, xp: 34, level: 2, level_note: "Подносчик шайб", picks: [{ tri: "UTA", game: "UTA — EDM" }] }], contest: { fans: { accuracy: 63, players: 2 }, hosts: { accuracy: 75, players: 1 }, leader: "hosts" } };
const MINE = { ok: true, questions: [{ id: 1, text: "Кто лучший вратарь?", status: "picked" }], ama: "20 октября, 19:00" };
function makeApp({ hosts = HOSTS, signedIn = true } = {}) {
  const dom = new JSDOM('<!doctype html><html class="v15Light"><head></head><body><main id="view"><section id="v29Me"></section><section id="v33Ach"></section></main></body></html>', { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  if (signedIn) window.Telegram = { WebApp: { initData: "query_id=AAE&hash=x" } };
  window.HOHV15 = {
    state: { profile: false }, currentTab: () => "follows",
    api: async (url, opt = {}) => {
      calls.push({ url, method: opt.method || "GET", body: opt.body ? JSON.parse(opt.body) : null });
      if (url === "/api/telegram-center-v35/hosts") return hosts;
      if (url === "/api/telegram-center-v35/hosts/9001/compare") return { ok: true, host: { name: "Иван Ведущий", settled: 4, correct: 3, accuracy: 75 }, me: { settled: 4, correct: 4, accuracy: 100 }, common: 4, agree: 3 };
      if (url === "/api/telegram-center-v35/questions" && opt.method === "POST") return { ok: true, level: 2 };
      if (url === "/api/telegram-center-v35/questions") return MINE;
      throw new Error(`unexpected ${url}`);
    },
  };
  window.eval(script);
  return { window, document: window.document, calls };
}
{
  const { window, document, calls } = makeApp();
  await tick(250);
  const card = document.getElementById("v35Hosts");
  assert.ok(card, "the card of the hosts on «Мои»");
  assert.equal(card.previousElementSibling.id, "v33Ach", "under the achievements");
  assert.equal(text(card.querySelector("[data-v35-contest]")), "63% зрители · 2 Ведут комментаторы 75% комментаторы · 1");
  assert.equal(text(card.querySelector(".v35Host small")), "Ур. 2 · угадано 3 из 4 · 75%");
  assert.match(text(card.querySelector(".v35Host")), /Сейчас за: UTA \(UTA — EDM\)/);
  card.querySelector("[data-v35-compare]").click();
  await tick(60);
  assert.ok(calls.some((x) => x.url === "/api/telegram-center-v35/hosts/9001/compare"));
  assert.equal(text(document.querySelector(".v35Cmp p")), "Общих прогнозов: 4, совпали 3");
  assert.deepEqual([...document.querySelectorAll(".v35Cmp div")].map(text), ["100% вы · 4 из 4", "75% Иван Ведущий · 3 из 4"]);
  // the questions: the date on air, my question with its status, a new one sent
  const ask = document.getElementById("v35Ask");
  assert.equal(ask.previousElementSibling.id, "v35Hosts");
  assert.equal(text(ask.querySelector(".v35Ama")), "🎙 Ответы в эфире: 20 октября, 19:00");
  assert.equal(text(ask.querySelector(".v35Mine li")), "Кто лучший вратарь? выбран для эфира 🎙");
  const area = ask.querySelector("[data-v35-text]");
  assert.ok(ask.querySelector("[data-v35-send]").disabled, "an empty question waits");
  area.value = "Почему Капризов не играет в меньшинстве?";
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(text(ask.querySelector(".v35Row small")), `осталось ${300 - area.value.length} знаков`);
  ask.querySelector("[data-v35-send]").click();
  await tick(60);
  assert.deepEqual(calls.find((x) => x.method === "POST").body, { text: "Почему Капризов не играет в меньшинстве?" });
  assert.equal(text(document.querySelector("#v35Ask .v35Row small")), "Вопрос отправлен ✅");
  assert.equal(document.querySelector("#v35Ask [data-v35-text]").value, "", "the field is cleared");
  window.close();
}
{
  // no hosts yet: a promise instead of an empty list; a guest: the hosts without «Сравнить», no questions
  const none = makeApp({ hosts: { ok: true, hosts: [], contest: null } });
  await tick(250);
  assert.equal(text(none.document.querySelector("#v35Hosts .v35Note")), "Как только комментаторы HOH сделают прогнозы, здесь можно будет сравнить свои прогнозы с их.");
  assert.equal(none.document.querySelector("[data-v35-contest]"), null);
  none.window.close();
  const guest = makeApp({ signedIn: false });
  await tick(250);
  assert.ok(guest.document.getElementById("v35Hosts"));
  assert.equal(guest.document.querySelector("[data-v35-compare]"), null);
  assert.equal(guest.document.getElementById("v35Ask"), null);
  guest.window.close();
}

console.log("hosts v35 validation passed");
