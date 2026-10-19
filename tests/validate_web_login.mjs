// «Войти через Telegram» on the website: the code and the 4 digits, the bot (/start login_<code>, «✅ Войти» / «Это не я», in the
// polling and in the webhook), the session key handed out once, only hashes in the database, the key turning into the same Telegram
// user for every API module, sign-out; the browser layer (the sheet, the key on /api requests, the account card); the app buttons
// of the bot open the app through the Moscow door.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JSDOM, VirtualConsole } from "jsdom";
import { SCRIPT_PATH, handleWebLogin, withWebSession, webSessionUser, startWebLogin, pollWebLogin, signInitData } from "../cloudflare-worker/src/telegram-center-web-login.js";
import { telegramAuth } from "../cloudflare-worker/src/telegram-center-v29-predictions.js";
import { handleTelegramProductBotRequest, pollTelegramCenterUpdates } from "../cloudflare-worker/src/telegram-product-bot.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const DOOR = "https://hoh.109-172-113-187.sslip.io";
const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- the database: the tables of the real migrations -----------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => migration(file).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
for (const t of ["teams", "games", "telegram_users"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(migration("0056_web_login.sql"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const TOKEN = "123456:TEST-BOT-TOKEN";
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } }, TELEGRAM_CENTER_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_VERIFY_SECRET: "webhook-secret", TELEGRAM_CENTER_DELIVERY_MODE: "polling" };
const call = async (path, { method = "GET", bearer, body } = {}) => {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await handleWebLogin(new Request(`https://x.test${path}`, { method, headers, body }), env, path.split("?")[0]);
  return { status: res.status, body: await res.json() };
};
const everyText = () => {
  const out = [];
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) for (const row of raw.prepare(`SELECT * FROM ${name}`).all()) out.push(JSON.stringify(row));
  return out.join("\n");
};
// nothing secret in the logs
const logged = [];
for (const k of ["log", "error", "warn"]) { const orig = console[k]; console[k] = (...a) => { logged.push(a.map(String).join(" ")); if (k !== "log") orig(...a); }; }

// ---- the Bot API, faked: what the bot sends -----------------------------------------------------------------------------------
const bot = [];
let pendingUpdates = [];
globalThis.fetch = async (url, opts = {}) => {
  const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(String(url));
  if (!m) throw new Error(`unexpected fetch ${url}`);
  const body = opts.body ? JSON.parse(opts.body) : {};
  bot.push({ method: m[1], body });
  if (m[1] === "getUpdates") { const result = pendingUpdates; pendingUpdates = []; return new Response(JSON.stringify({ ok: true, result })); }
  if (m[1] === "getChatMenuButton") return new Response(JSON.stringify({ ok: true, result: { type: "web_app", text: "Center", web_app: { url: `${DOOR}/telegram-app-v24?build=24.8.0` } } }));
  if (m[1] === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "" } }));
  return new Response(JSON.stringify({ ok: true, result: true }));
};
let updateId = 1000;
const FAN = { id: 777, is_bot: false, first_name: "Иван", username: "ivan_fan" };
const message = (text, from = FAN) => ({ update_id: ++updateId, message: { message_id: updateId, from, chat: { id: from.id, type: "private" }, date: 1, text } });
const press = (data, msgId, from = FAN) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from, data, message: { message_id: msgId, chat: { id: from.id, type: "private" } } } });
async function viaPolling(update) { pendingUpdates = [update]; const r = await pollTelegramCenterUpdates(env); assert.equal(r.ok, true, JSON.stringify(r)); }
async function viaWebhook(update) {
  const res = await handleTelegramProductBotRequest(new Request("https://x.test/api/telegram/center", { method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": sha("webhook-secret") }, body: JSON.stringify(update) }), env, "/api/telegram/center");
  assert.equal(res.status, 200);
  return res.json();
}
const sent = (method) => bot.filter((x) => x.method === method).at(-1)?.body;

// ---- 1) a login: the code, the 4 digits, the links; only the hash is stored ------------------------------------------------------
const started = await call("/api/web-login", { method: "POST", body: "{}" });
assert.equal(started.status, 200);
const L = started.body;
assert.match(L.code, /^[A-Za-z0-9_-]{24}$/);
assert.match(L.check, /^\d{4}$/);
assert.equal(L.bot_link, `https://t.me/HOH_NHL_Center_bot?start=login_${L.code}`);
assert.equal(L.app_link, `tg://resolve?domain=HOH_NHL_Center_bot&start=login_${L.code}`);
assert.ok(Date.parse(L.expires_at) - Date.now() > 9 * 60_000 && Date.parse(L.expires_at) - Date.now() <= 10 * 60_000, "10 minutes");
assert.ok(everyText().includes(sha(L.code)) && !everyText().includes(L.code), "only the sha256 of the code is in the database");
assert.deepEqual((await call(`/api/web-login?code=${L.code}`)).body, { ok: true, state: "waiting" });
assert.equal((await call("/api/web-login?code=x")).status, 400);

// ---- 2) the bot (polling mode, as in production): /start login_<code> shows the same digits and two buttons --------------------
await viaPolling(message(`/start login_${L.code}`));
const ask = sent("sendMessage");
assert.equal(ask.chat_id, 777);
assert.match(ask.text, new RegExp(`На сайте должен быть код <b>${L.check}</b>`));
const [[ok, no]] = ask.reply_markup.inline_keyboard;
assert.deepEqual([ok.text, no.text], ["✅ Войти", "Это не я"]);
assert.match(ok.callback_data, /^wl:ok:\d+$/);
assert.ok(!bot.some((x) => x.method === "sendMessage" && /HOH NHL Center/.test(x.body.text || "")), "the login does not also get the usual /start reply");
// the polling setup keeps the «Приложение» button on the Moscow door
const menu = bot.filter((x) => x.method === "setChatMenuButton").map((x) => x.body.menu_button?.web_app?.url).filter(Boolean);
assert.ok(menu.length && menu.every((u) => u.startsWith(`${DOOR}/telegram-app-v24`)), `menu button: ${menu}`);

// «✅ Войти» — any user, not only an admin
await viaPolling(press(ok.callback_data, 55));
assert.equal(sent("editMessageText").text, "✅ Готово — сайт вас узнал. Можно вернуться в браузер.");
assert.equal(sent("answerCallbackQuery").text, "Вход выполнен");

// ---- 3) the key: handed out once, 180 days, only its hash stored -------------------------------------------------------------
const got = (await call(`/api/web-login?code=${L.code}`)).body;
assert.equal(got.state, "ok");
assert.match(got.token, /^[A-Za-z0-9_-]{43}$/);
assert.deepEqual(got.user, { id: 777, first_name: "Иван", username: "ivan_fan" });
assert.ok(Math.abs(Date.parse(got.expires_at) - Date.now() - 180 * 86400e3) < 60_000);
assert.deepEqual((await call(`/api/web-login?code=${L.code}`)).body, { ok: true, state: "expired" }, "the key cannot be taken twice");
assert.ok(everyText().includes(sha(got.token)) && !everyText().includes(got.token), "only the sha256 of the key is in the database");
const KEY = got.token;
assert.deepEqual((await call("/api/web-session", { bearer: KEY })).body, { ok: true, user: { id: 777, first_name: "Иван", username: "ivan_fan" } });
assert.equal((await call("/api/web-session", { bearer: "A".repeat(43) })).status, 401, "a made-up key");
assert.equal((await call("/api/web-session")).status, 401);

// ---- 4) every API module sees the same Telegram user -------------------------------------------------------------------------
const asUser = async (headers) => telegramAuth(await withWebSession(new Request("https://x.test/api/telegram-center-v29/me", { headers }), env), env, true);
const viaKey = await asUser({ Authorization: `Bearer ${KEY}` });
assert.equal(viaKey.ok, true);
assert.deepEqual([viaKey.user.id, viaKey.user.first_name, viaKey.user.username], [777, "Иван", "ivan_fan"]);
assert.deepEqual(await asUser({ Authorization: `Bearer ${"B".repeat(43)}` }), { ok: false, error: "missing_telegram_init_data" }, "a made-up key stays a guest");
assert.deepEqual(await asUser({}), { ok: false, error: "missing_telegram_init_data" });
// inside Telegram the real initData wins over any key
const real = await signInitData({ id: 555, first_name: "Пётр" }, TOKEN);
assert.equal((await asUser({ "X-Telegram-Init-Data": real, Authorization: `Bearer ${KEY}` })).user.id, 555);
// a POST body survives the change of headers
const posted = await withWebSession(new Request("https://x.test/api/telegram-center-v35/questions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Вопрос" }) }), env);
assert.deepEqual(await posted.json(), { text: "Вопрос" });
assert.ok(posted.headers.get("x-telegram-init-data"));
// the same through the whole Worker: 401 for a made-up key, the user for the real one
{
  const { default: worker } = await import("../cloudflare-worker/src/worker-entry.js");
  raw.exec(createOf("0048_fan_predictions.sql", "fan_predictions"));
  raw.exec(migration("0055_hosts_questions.sql"));
  const q = (bearer) => worker.fetch(new Request("https://x.test/api/telegram-center-v35/questions", { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }), env);
  assert.equal((await q("C".repeat(43))).status, 401);
  const mine = await q(KEY);
  assert.equal(mine.status, 200);
  assert.deepEqual((await mine.json()).questions, []);
}

// ---- 5) «Это не я», an old link, a used link (webhook mode) ------------------------------------------------------------------
{
  const D = (await call("/api/web-login", { method: "POST", body: "{}" })).body;
  await viaWebhook(message(`/start login_${D.code}`));
  const no2 = sent("sendMessage").reply_markup.inline_keyboard[0][1].callback_data;
  assert.match(no2, /^wl:no:\d+$/);
  assert.equal((await viaWebhook(press(no2, 56))).action, "web_login_answer");
  assert.equal(sent("editMessageText").text, "Вход отменён. Никто не вошёл под вашим именем.");
  assert.deepEqual((await call(`/api/web-login?code=${D.code}`)).body, { ok: true, state: "declined" });
  await viaWebhook(press(no2.replace("no", "ok"), 56));
  assert.match(sent("editMessageText").text, /уже не действует/, "a declined login cannot be confirmed afterwards");
  await viaWebhook(message(`/start login_${D.code}`));
  assert.equal(sent("sendMessage").text, "Эта ссылка для входа уже использована.");
  const old = await startWebLogin(env, Date.now() - 11 * 60_000);
  await viaWebhook(message(`/start login_${old.code}`));
  assert.match(sent("sendMessage").text, /^Ссылка для входа устарела/);
  assert.deepEqual(await pollWebLogin(env, old.code), { ok: true, state: "expired" });
  await viaWebhook(message("/start login_short"));
  assert.match(sent("sendMessage").text, /^Ссылка для входа неполная/);
}
// an old session ends by itself and is cleaned away
{
  raw.prepare("INSERT INTO web_sessions(token_hash,telegram_user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)").run(sha("D".repeat(43)), 9, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z");
  assert.equal(await webSessionUser(env, "D".repeat(43)), null);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM web_sessions WHERE token_hash=?").get(sha("D".repeat(43))).n, 0);
}
// a flood of logins is stopped
{
  const ins = raw.prepare("INSERT INTO web_logins(code_hash,check_code,created_at,expires_at) VALUES(?,?,?,?)");
  for (let i = 0; i < 500; i++) ins.run(`flood${i}`, "0000", new Date().toISOString(), new Date(Date.now() + 600_000).toISOString());
  assert.equal((await call("/api/web-login", { method: "POST", body: "{}" })).status, 429);
  raw.exec("DELETE FROM web_logins WHERE code_hash LIKE 'flood%'");
}
// ---- 6) sign-out --------------------------------------------------------------------------------------------------------------
assert.deepEqual((await call("/api/web-logout", { method: "POST", bearer: KEY, body: "{}" })).body, { ok: true });
assert.equal((await call("/api/web-session", { bearer: KEY })).status, 401);
assert.deepEqual(await asUser({ Authorization: `Bearer ${KEY}` }), { ok: false, error: "missing_telegram_init_data" });
assert.ok(!logged.some((line) => line.includes(KEY) || line.includes(L.code)), "neither the key nor the code is ever logged");

// ---- 7) the app buttons of the bot open the app through the door -------------------------------------------------------------
{
  await viaWebhook(message("/start"));
  const start = sent("sendMessage");
  assert.equal(start.reply_markup.inline_keyboard[0][0].web_app.url, `${DOOR}/telegram-app-v24?build=24.8.0`);
  const v29 = fs.readFileSync(new URL("../cloudflare-worker/src/telegram-center-v29-predictions.js", import.meta.url), "utf8");
  assert.match(v29, /const MINI_APP_URL = "https:\/\/hoh\.109-172-113-187\.sslip\.io\/telegram-app-v24";/, "the morning digest button too");
}

// ---- 8) the browser ---------------------------------------------------------------------------------------------------------
const script = await (await handleWebLogin(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).text();
assert.match(script, /^\(function\(\)\{const __name=/);
const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
assert.ok(shell.indexOf(`/telegram-app/v36-login.js?build=36.0`) < shell.indexOf("/telegram-app/v9.js"), "the sign-in layer runs before every other layer");
assert.ok(shell.indexOf("telegram-web-app.js") < shell.indexOf("/telegram-app/v36-login.js"));

const TOKEN_B = "T".repeat(43);
function page({ telegram = false, session = null, pending = null, responses = {} } = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (!/navigation/.test(String(e.message))) console.error(e); });
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="view"><section id="v15Theme"></section></main></body></html>', { url: `${DOOR}/telegram-app-v24`, runScripts: "outside-only", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), window.location.href);
    const headers = new window.Headers(opts.headers || {});
    calls.push({ url: u.pathname + u.search, origin: u.origin, method: opts.method || "GET", auth: headers.get("Authorization") });
    const r = responses[`${opts.method || "GET"} ${u.pathname}`];
    const value = typeof r === "function" ? r() : r;
    const [status, body] = Array.isArray(value) ? value : [200, value || { ok: true }];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  window.alert = () => {};
  if (telegram) window.Telegram = { WebApp: { initData: "query_id=1&hash=x", initDataUnsafe: { user: { id: 1 } } } };
  if (session) window.localStorage.setItem("hoh-web-session-v1", JSON.stringify(session));
  if (pending) window.sessionStorage.setItem("hoh-web-login-v1", JSON.stringify(pending));
  window.eval(script);
  return { window, document: window.document, calls };
}
const LOGIN = { ok: true, code: "C".repeat(24), check: "4821", bot: "HOH_NHL_Center_bot", bot_link: "https://t.me/HOH_NHL_Center_bot?start=login_" + "C".repeat(24), app_link: "tg://resolve?domain=HOH_NHL_Center_bot&start=login_" + "C".repeat(24), expires_at: new Date(Date.now() + 600_000).toISOString() };
{
  // a guest on the website: the account card at the top of «Мои», the sheet, the waiting, the key saved
  let polls = 0;
  const { window, document, calls } = page({ responses: { "POST /api/web-login": LOGIN, "GET /api/web-login": () => (++polls < 2 ? { ok: true, state: "waiting" } : { ok: true, state: "ok", token: TOKEN_B, user: { id: 777, first_name: "Иван", username: "ivan_fan" }, expires_at: "2027-04-13T18:00:00.000Z" }) } });
  assert.equal(window.HOHAuth.signedIn(), false);
  await tick(200);
  const card = document.getElementById("hohAccount");
  assert.ok(card && card.nextElementSibling.id === "v15Theme", "the account card opens «Мои»");
  assert.match(card.textContent, /Войдите через Telegram/);
  card.querySelector("[data-hoh-login]").click();
  await tick(30);
  assert.deepEqual(calls.filter((c) => c.url === "/api/web-login").map((c) => c.method), ["POST"]);
  const sheet = document.querySelector(".hohSheetBack .hohSheet");
  assert.ok(sheet, "the sheet");
  assert.equal(sheet.querySelector("[data-hoh-check]").textContent, "4821");
  assert.equal(sheet.querySelector("a.hohLoginBtn").getAttribute("href"), LOGIN.bot_link);
  assert.equal(sheet.querySelector("a.hohAlt").getAttribute("href"), LOGIN.app_link);
  assert.equal(JSON.parse(window.sessionStorage.getItem("hoh-web-login-v1")).code, LOGIN.code, "the waiting survives a reload of the tab");
  await tick(5300);
  assert.equal(polls, 2, "asked every 2.5 s");
  assert.equal(JSON.parse(window.localStorage.getItem("hoh-web-session-v1")).token, TOKEN_B);
  assert.equal(window.sessionStorage.getItem("hoh-web-login-v1"), null);
  assert.equal(document.querySelector(".hohSheetBack"), null);
  window.close();
}
{
  // the phone came back from Telegram and reloaded the tab: the same code is waited for
  const { document, window, calls } = page({ pending: LOGIN, responses: { "GET /api/web-login": { ok: true, state: "declined" } } });
  await tick(50);
  assert.equal(document.querySelector("[data-hoh-check]").textContent, "4821");
  assert.ok(calls.some((c) => c.url === `/api/web-login?code=${LOGIN.code}`));
  assert.match(document.querySelector("[data-hoh-state]").textContent, /Вход отменён в боте/);
  assert.ok(document.querySelector("[data-hoh-state] [data-hoh-login]"), "«Попробовать ещё раз»");
  window.close();
}
{
  // signed in on the website: the key goes with our /api requests only; the card offers sign-out
  const { window, document, calls } = page({ session: { token: TOKEN_B, user: { id: 777, first_name: "Иван", username: "ivan_fan" } }, responses: { "GET /api/web-session": { ok: true, user: { id: 777, first_name: "Иван", username: "ivan_fan" } } } });
  assert.equal(window.HOHAuth.signedIn(), true);
  assert.equal(window.HOHAuth.inTelegram(), false);
  await window.fetch("/api/telegram-center-v29/me");
  await window.fetch("https://other.example/api/x");
  await window.fetch("/telegram-app/v9.js");
  const auth = calls.filter((c) => c.url !== "/api/web-session").map((c) => [c.url, c.auth]);
  assert.deepEqual(auth, [["/api/telegram-center-v29/me", `Bearer ${TOKEN_B}`], ["/api/x", null], ["/telegram-app/v9.js", null]]);
  await tick(200);
  const card = document.getElementById("hohAccount");
  assert.match(card.textContent, /Вы вошли через Telegram/);
  assert.match(card.textContent, /Иван @ivan_fan/);
  card.querySelector("[data-hoh-logout]").click();
  await tick(30);
  const out = calls.find((c) => c.url === "/api/web-logout");
  assert.deepEqual([out.method, out.auth], ["POST", `Bearer ${TOKEN_B}`]);
  assert.equal(window.localStorage.getItem("hoh-web-session-v1"), null);
  window.close();
}
{
  // a key the server no longer knows is forgotten
  const { window } = page({ session: { token: TOKEN_B, user: { id: 777 } }, responses: { "GET /api/web-session": [401, { ok: false, error: "web_session_invalid" }] } });
  await tick(50);
  assert.equal(window.localStorage.getItem("hoh-web-session-v1"), null);
  window.close();
}
{
  // inside Telegram nothing changes: no key, no card, no sheet
  const { window, document, calls } = page({ telegram: true, session: { token: TOKEN_B } });
  assert.equal(window.HOHAuth.signedIn(), true);
  assert.equal(window.HOHAuth.inTelegram(), true);
  await window.fetch("/api/telegram-center-v29/me");
  assert.equal(calls.at(-1).auth, null);
  await tick(200);
  assert.equal(document.getElementById("hohAccount"), null);
  window.close();
}
{
  // a layer's «только в Telegram» becomes the button: «Задай вопрос ведущим» for a website guest
  const v35 = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app/v35-hosts.js"), env, "/telegram-app/v35-hosts.js")).text();
  const { window, document } = page({ responses: {} });
  document.getElementById("view").insertAdjacentHTML("beforeend", '<section id="v29Me"></section><section id="v33Ach"></section>');
  window.HOHV15 = { state: { profile: false }, currentTab: () => "follows", api: async (url) => (url.endsWith("/hosts") ? { ok: true, hosts: [], contest: null } : { ok: true, questions: [] }) };
  window.eval(v35);
  await tick(300);
  const ask = document.getElementById("v35Ask");
  assert.ok(ask && ask.querySelector("[data-hoh-login]"), "the login button instead of nothing");
  assert.match(ask.textContent, /Войдите через Telegram, чтобы задать вопрос комментаторам/);
  window.close();
}

process.stdout.write("web login validation passed\n"); // console.log is captured above to check the logs for secrets
