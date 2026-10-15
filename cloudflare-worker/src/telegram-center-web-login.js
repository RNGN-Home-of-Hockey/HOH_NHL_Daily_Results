// «Войти через Telegram» on the website (the app opened in a browser, e.g. through the no-VPN door
// https://hoh.109-172-113-187.sslip.io), so predictions, points, «Мои», questions and achievements are the same Telegram
// account as in the Mini App. The same scheme as the tennis app «Больше» (BOLSHE-Live-Center c3270a4):
//   1. the site asks POST /api/web-login → a secret code (goes into the bot link) and 4 check digits, 10 minutes;
//   2. the fan opens @HOH_NHL_Center_bot with /start login_<code>, sees the same 4 digits and presses «✅ Войти»;
//   3. the site asks GET /api/web-login?code=… every few seconds and gets its session key once (180 days);
//   4. the browser sends `Authorization: Bearer <key>`; POST /api/web-logout ends that session.
// Only sha256 of the code and of the key are stored (migration 0056); neither is ever written to a log.
//
// The twelve API modules of the app each check the Telegram initData themselves. Instead of teaching all of them the
// session, withWebSession() turns a valid session into initData signed here with the same bot token, for this one
// request inside the Worker: every module then sees the same person as in Telegram. A wrong or old key adds nothing,
// so the request stays a guest's (401 where an account is needed).
import { webLoginUi } from "./telegram-center-web-login-ui.js";

export const SCRIPT_PATH = "/telegram-app/v36-login.js";
export const BOT_USERNAME = "HOH_NHL_Center_bot";
const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 180 * 86400e3;
const SEEN_EVERY_MS = 3600e3;
const MAX_PENDING = 500;
const CODE_RE = /^[A-Za-z0-9_-]{20,64}$/;
const TOKEN_RE = /^Bearer\s+([A-Za-z0-9_-]{30,80})$/;

const iso = (ms) => new Date(ms).toISOString();
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const randomToken = (n) => base64url(crypto.getRandomValues(new Uint8Array(n)));
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const botName = (env) => String(env?.TELEGRAM_CENTER_BOT_USERNAME || BOT_USERNAME).replace(/^@/, "");

export async function handleWebLogin(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    return new Response(`(function(){const __name=(target,value)=>target;(${webLoginUi.toString()})();})();`, { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
  }
  if (!["/api/web-login", "/api/web-logout", "/api/web-session"].includes(path)) return null;
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  try {
    if (path === "/api/web-login" && request.method === "POST") {
      const result = await startWebLogin(env);
      return json(result, result.ok ? 200 : result.status || 400);
    }
    if (path === "/api/web-login" && request.method === "GET") {
      const result = await pollWebLogin(env, new URL(request.url).searchParams.get("code"));
      return json(result, result.ok ? 200 : result.status || 400);
    }
    if (path === "/api/web-logout" && request.method === "POST") return json(await endWebSession(env, request));
    if (path === "/api/web-session" && request.method === "GET") {
      const user = await webSessionUser(env, bearer(request));
      return user ? json({ ok: true, user }) : json({ ok: false, error: "web_session_invalid" }, 401);
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("web login failed", String(error?.message || error));
    return json({ ok: false, error: "web_login_failed" }, 500);
  }
}

export async function startWebLogin(env, nowMs = Date.now()) {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM web_logins WHERE expires_at < ?;").bind(iso(nowMs - 86400e3)),
    db.prepare("DELETE FROM web_sessions WHERE expires_at < ?;").bind(iso(nowMs)),
  ]);
  const pending = await db.prepare("SELECT COUNT(*) n FROM web_logins WHERE expires_at > ? AND telegram_user_id IS NULL AND declined_at IS NULL;").bind(iso(nowMs)).first();
  if (Number(pending?.n) >= MAX_PENDING) return { ok: false, status: 429, error: "too_many_logins" };
  const code = randomToken(18);
  const check = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
  await db.prepare("INSERT INTO web_logins(code_hash,check_code,created_at,expires_at) VALUES(?,?,?,?);").bind(await sha256(code), check, iso(nowMs), iso(nowMs + LOGIN_TTL_MS)).run();
  const bot = botName(env);
  return {
    ok: true, code, check, expires_at: iso(nowMs + LOGIN_TTL_MS), bot,
    bot_link: `https://t.me/${bot}?start=login_${code}`,
    app_link: `tg://resolve?domain=${bot}&start=login_${code}`,
  };
}

// The key is handed out once: the confirmed login row goes away with it (DELETE … RETURNING).
export async function pollWebLogin(env, code, nowMs = Date.now()) {
  if (!CODE_RE.test(String(code ?? ""))) return { ok: false, status: 400, error: "bad_code" };
  const db = env.DB, hash = await sha256(code);
  const done = await db.prepare("DELETE FROM web_logins WHERE code_hash=? AND telegram_user_id IS NOT NULL RETURNING telegram_user_id,first_name,username;").bind(hash).first();
  if (done) {
    const token = randomToken(32);
    await db.prepare("INSERT INTO web_sessions(token_hash,telegram_user_id,first_name,username,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?,?);")
      .bind(await sha256(token), done.telegram_user_id, done.first_name, done.username, iso(nowMs), iso(nowMs), iso(nowMs + SESSION_TTL_MS)).run();
    return { ok: true, state: "ok", token, expires_at: iso(nowMs + SESSION_TTL_MS), user: { id: Number(done.telegram_user_id), first_name: done.first_name || null, username: done.username || null } };
  }
  const row = await db.prepare("SELECT expires_at,declined_at FROM web_logins WHERE code_hash=?;").bind(hash).first();
  if (!row || Date.parse(row.expires_at) < nowMs) return { ok: true, state: "expired" };
  return { ok: true, state: row.declined_at ? "declined" : "waiting" };
}

export function bearer(request) {
  return String(request?.headers?.get("authorization") || "").match(TOKEN_RE)?.[1] || null;
}

// The signed-in fan of a website request, or null.
export async function webSessionUser(env, token, nowMs = Date.now()) {
  if (!token || !env?.DB) return null;
  const db = env.DB, hash = await sha256(token);
  const row = await db.prepare("SELECT telegram_user_id,first_name,username,last_seen,expires_at FROM web_sessions WHERE token_hash=?;").bind(hash).first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < nowMs) {
    await db.prepare("DELETE FROM web_sessions WHERE token_hash=?;").bind(hash).run();
    return null;
  }
  if (nowMs - Date.parse(row.last_seen) > SEEN_EVERY_MS) await db.prepare("UPDATE web_sessions SET last_seen=? WHERE token_hash=?;").bind(iso(nowMs), hash).run();
  return { id: Number(row.telegram_user_id), first_name: row.first_name || null, username: row.username || null };
}

export async function endWebSession(env, request) {
  const token = bearer(request);
  if (token) await env.DB.prepare("DELETE FROM web_sessions WHERE token_hash=?;").bind(await sha256(token)).run();
  return { ok: true };
}

// initData for a signed-in website fan, signed with the bot token exactly as Telegram signs it for the Mini App.
export async function signInitData(user, botToken, nowMs = Date.now()) {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(nowMs / 1000)));
  params.set("via", "web");
  params.set("user", JSON.stringify(Object.fromEntries(Object.entries({ id: Number(user.id), first_name: user.first_name || undefined, username: user.username || undefined }).filter(([, v]) => v !== undefined))));
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const e = new TextEncoder();
  const k1 = await crypto.subtle.importKey("raw", e.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, e.encode(botToken));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", k2, e.encode(check)));
  params.set("hash", [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}

// Every /api/ request goes through here first (worker-entry.js). Inside Telegram the real initData always wins.
export async function withWebSession(request, env) {
  if (String(request.headers.get("x-telegram-init-data") || "").trim()) return request;
  const token = bearer(request);
  const botToken = String(env?.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token || !botToken) return request;
  let user = null;
  try { user = await webSessionUser(env, token); } catch (error) { console.error("web session read failed", String(error?.message || error)); }
  if (!user) return request;
  const headers = new Headers(request.headers);
  headers.set("X-Telegram-Init-Data", await signInitData(user, botToken));
  return new Request(request, { headers });
}

// ---- the bot side: /start login_<code> and the buttons «✅ Войти» / «Это не я» (for every user, not only admins) ----

export async function loginForBot(env, code, nowMs = Date.now()) {
  const again = "нажмите «Войти через Telegram» на сайте ещё раз";
  if (!CODE_RE.test(String(code ?? ""))) return { error: `Ссылка для входа неполная — ${again}.` };
  const row = await env.DB.prepare("SELECT login_id,check_code,expires_at,telegram_user_id,declined_at FROM web_logins WHERE code_hash=?;").bind(await sha256(code)).first();
  if (!row || Date.parse(row.expires_at) < nowMs) return { error: `Ссылка для входа устарела — ${again}.` };
  if (row.telegram_user_id || row.declined_at) return { error: "Эта ссылка для входа уже использована." };
  return { id: Number(row.login_id), check: row.check_code };
}

export async function answerLogin(env, id, from, yes, nowMs = Date.now()) {
  const now = iso(nowMs);
  const res = yes
    ? await env.DB.prepare("UPDATE web_logins SET telegram_user_id=?,first_name=?,username=?,confirmed_at=? WHERE login_id=? AND telegram_user_id IS NULL AND declined_at IS NULL AND expires_at>?;")
      .bind(Number(from.id), from.first_name || null, from.username || null, now, id, now).run()
    : await env.DB.prepare("UPDATE web_logins SET declined_at=? WHERE login_id=? AND telegram_user_id IS NULL AND declined_at IS NULL;").bind(now, id).run();
  return Number(res?.meta?.changes ?? 0) > 0;
}

// One update of the bot (webhook or polling). tg(method, payload) calls the Bot API. { handled } as the admin bot does.
export async function handleWebLoginUpdate(env, update, tg) {
  if (!env?.DB) return { handled: false };
  const cq = update?.callback_query;
  const pressed = String(cq?.data || "").match(/^wl:(ok|no):(\d+)$/);
  if (pressed) {
    const chatId = cq.message?.chat?.id, yes = pressed[1] === "ok";
    const done = await answerLogin(env, Number(pressed[2]), cq.from || {}, yes);
    const text = !done ? "Эта ссылка для входа уже не действует — нажмите «Войти через Telegram» на сайте ещё раз."
      : yes ? "✅ Готово — сайт вас узнал. Можно вернуться в браузер." : "Вход отменён. Никто не вошёл под вашим именем.";
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: done && yes ? "Вход выполнен" : "" });
    if (chatId && cq.message?.message_id) await tg("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text });
    return { handled: true, action: "web_login_answer", confirmed: done && yes };
  }
  const message = update?.message;
  const start = String(message?.text || "").match(/^\/start(?:@\w+)?\s+login_(\S+)\s*$/);
  if (!start || message?.chat?.type !== "private") return { handled: false };
  const login = await loginForBot(env, start[1]);
  if (login.error) {
    await tg("sendMessage", { chat_id: message.chat.id, text: login.error });
    return { handled: true, action: "web_login_refused" };
  }
  await tg("sendMessage", {
    chat_id: message.chat.id,
    parse_mode: "HTML",
    text: ["🔐 <b>Вход на сайт Home of Hockey</b>", "", `На сайте должен быть код <b>${login.check}</b>.`,
      "Если код совпадает и это вы — нажмите «Войти». Прогнозы, очки и подписки будут общими с приложением в Telegram.", "",
      "Не открывали сайт? Нажмите «Это не я»."].join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "✅ Войти", callback_data: `wl:ok:${login.id}` }, { text: "Это не я", callback_data: `wl:no:${login.id}` }]] },
  });
  return { handled: true, action: "web_login_asked" };
}
