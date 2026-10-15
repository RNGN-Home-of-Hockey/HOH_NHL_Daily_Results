// The browser side of «Войти через Telegram» (server: telegram-center-web-login.js). Served as /telegram-app/v36-login.js
// and loaded right after telegram-web-app.js, before every other layer of the app:
//   • window.HOHAuth — signedIn() (the Telegram initData, or the website session), login(), logout(), the login button;
//   • every same-origin /api/ request of a signed-in website visitor carries `Authorization: Bearer <key>`;
//   • the sheet with the 4 check digits, the link to the bot and the waiting (survives a page reload: phones reload the tab
//     when they come back from Telegram);
//   • the account card at the top of «Мои» and in the profile settings: sign in, or «Выйти на этом устройстве».
// Inside Telegram it changes nothing.
export function webLoginUi() {
  const tg = window.Telegram && window.Telegram.WebApp;
  const real = Boolean(tg && tg.initData);
  const SESSION = "hoh-web-session-v1", PENDING = "hoh-web-login-v1";
  const TOKEN_RE = /^[A-Za-z0-9_-]{30,80}$/;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const read = (area, key) => { try { return JSON.parse(window[area].getItem(key) || "null"); } catch (e) { return null; } };
  const write = (area, key, value) => { try { if (value) window[area].setItem(key, JSON.stringify(value)); else window[area].removeItem(key); } catch (e) { /* storage may be blocked */ } };
  let session = real ? null : read("localStorage", SESSION);
  if (session && !TOKEN_RE.test(String(session.token || ""))) session = null;

  // ---- the key goes with every request of the app to our API -------------------------------------------------------------
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch && !real) {
    window.fetch = function (input, init) {
      try {
        if (session && session.token) {
          const url = new URL(typeof input === "string" ? input : (input && input.url) || String(input), location.href);
          if (url.origin === location.origin && url.pathname.indexOf("/api/") === 0) {
            const headers = new Headers((init && init.headers) || (input && typeof input !== "string" && input.headers) || undefined);
            if (!headers.has("Authorization")) headers.set("Authorization", "Bearer " + session.token);
            if (input && typeof input !== "string" && !init && typeof Request !== "undefined" && input instanceof Request) return nativeFetch(new Request(input, { headers }));
            return nativeFetch(input, Object.assign({}, init || {}, { headers }));
          }
        }
      } catch (e) { /* fall through to the plain request */ }
      return nativeFetch(input, init);
    };
  }
  const api = async (url, opts) => {
    const r = await window.fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
    return d;
  };

  const TG_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.4 4.2 2.9 11.3c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.4-1.5zM9.4 14l8.6-5.4c.4-.3.8-.1.5.2l-7.1 6.4-.3 3.2z"/></svg>';
  const button = (label) => `<button class="hohLoginBtn" type="button" data-hoh-login><span class="ic">${TG_ICON}</span><span>${esc(label || "Войти через Telegram")}</span></button>`;
  const needLogin = (text) => `<div class="hohNeedLogin"><p>${esc(text)}</p>${button()}</div>`;
  const auth = {
    inTelegram: () => real,
    signedIn: () => real || Boolean(session && session.token),
    web: () => !real,
    user: () => (real ? (tg.initDataUnsafe && tg.initDataUnsafe.user) || null : (session && session.user) || null),
    button, needLogin,
    login: () => startLogin(),
    logout: () => logout(),
  };
  window.HOHAuth = auth;
  if (real) return;

  const css = `
.hohLoginBtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:46px;border:0;border-radius:14px;background:#2aabee;color:#fff!important;font:inherit;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer;box-shadow:0 8px 24px rgba(42,171,238,.28)}
.hohLoginBtn .ic{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#fff;color:#2aabee}.hohLoginBtn .ic svg{width:17px;height:17px}
.hohNeedLogin{display:grid;gap:10px;margin:8px 0}.hohNeedLogin p{margin:0;font-size:13px;line-height:1.4;opacity:.85}
.hohAccount{display:grid;gap:10px;margin:0 0 12px;padding:14px;border-radius:18px;border:1px solid rgba(42,171,238,.35);background:rgba(42,171,238,.10);color:inherit}
.hohAccount b{font-size:15px}.hohAccount p{margin:0;font-size:13px;line-height:1.4;opacity:.85}
.hohAccount .hohOut{justify-self:start;border:1px solid currentColor;border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:700;padding:9px 14px;cursor:pointer;opacity:.85}
.hohSheetBack{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(6,7,12,.62);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.hohSheet{position:relative;box-sizing:border-box;width:100%;max-width:520px;max-height:92vh;overflow:auto;display:grid;gap:12px;padding:20px 18px calc(22px + env(safe-area-inset-bottom));border-radius:24px 24px 0 0;background:#12141c;color:#f4f5fa;border:1px solid #2a2d3a;font-family:inherit}
html.v15Light .hohSheet{background:#fff;color:#0c0d14;border-color:#e2e4ec}
.hohSheet h2{margin:0;font-size:20px}.hohSheet ol{margin:0;padding-left:20px;font-size:14px;line-height:1.6;opacity:.8}
.hohSheetX{position:absolute;right:12px;top:12px;width:34px;height:34px;border:0;border-radius:50%;background:rgba(127,127,127,.18);color:inherit;font-size:16px;cursor:pointer}
.hohCode{text-align:center;font-size:46px;font-weight:900;letter-spacing:.2em;padding:6px 0 6px .2em;border-radius:16px;background:rgba(42,171,238,.13);color:#2aabee}
.hohAlt{text-align:center;font-size:13px;color:inherit;opacity:.7}
.hohState{display:grid;gap:10px;text-align:center;font-size:13px;opacity:.85}`;
  const style = document.createElement("style");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // ---- the sign-in sheet -------------------------------------------------------------------------------------------------
  let timer = null, current = null;
  function closeLogin(keepPending) {
    clearInterval(timer);
    timer = null;
    current = null;
    const back = document.querySelector(".hohSheetBack");
    if (back) back.remove();
    if (!keepPending) write("sessionStorage", PENDING, null);
  }
  function showLogin(d) {
    const old = document.querySelector(".hohSheetBack");
    if (old) old.remove();
    current = d;
    const back = document.createElement("div");
    back.className = "hohSheetBack";
    back.innerHTML = `<div class="hohSheet" role="dialog" aria-label="Вход через Telegram"><button class="hohSheetX" type="button" data-hoh-close aria-label="Закрыть">✕</button>
      <h2>Вход через Telegram</h2>
      <ol><li>Нажмите кнопку — откроется наш бот @${esc(d.bot || "HOH_NHL_Center_bot")}.</li><li>Если бот попросит — нажмите «Запустить».</li><li>Проверьте, что в боте тот же код, и нажмите «✅ Войти».</li></ol>
      <div class="hohCode" data-hoh-check>${esc(d.check)}</div>
      <a class="hohLoginBtn" href="${esc(d.bot_link)}" target="_blank" rel="noopener"><span class="ic">${TG_ICON}</span><span>Открыть бота</span></a>
      <a class="hohAlt" href="${esc(d.app_link)}">Не открывается? Открыть приложение Telegram</a>
      <div class="hohState" data-hoh-state>Ждём подтверждения в боте… Бот отвечает в течение минуты.</div></div>`;
    document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back || (e.target.closest && e.target.closest("[data-hoh-close]"))) closeLogin(); });
    clearInterval(timer);
    timer = setInterval(check, 2500);
  }
  async function check() {
    const d = current;
    if (!d) return;
    let r;
    try { r = await api("/api/web-login?code=" + encodeURIComponent(d.code)); } catch (e) { return; }
    if (d !== current) return;
    const state = document.querySelector("[data-hoh-state]");
    if (r.state === "ok" && r.token) {
      session = { token: r.token, user: r.user || null, until: r.expires_at || null };
      write("localStorage", SESSION, session);
      closeLogin();
      location.reload(); // every layer of the app reads the sign-in when it starts
    } else if (r.state === "expired" || r.state === "declined") {
      clearInterval(timer);
      timer = null;
      write("sessionStorage", PENDING, null);
      if (state) state.innerHTML = `<span>${r.state === "expired" ? "Время на вход вышло." : "Вход отменён в боте."}</span>${button("Попробовать ещё раз")}`;
    }
  }
  async function startLogin() {
    if (real) return;
    try {
      const d = await api("/api/web-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      write("sessionStorage", PENDING, d);
      showLogin(d);
    } catch (e) {
      alert(e && e.status === 429 ? "Слишком много попыток входа. Попробуйте через несколько минут." : "Не удалось начать вход. Проверьте интернет и попробуйте ещё раз.");
    }
  }
  async function logout() {
    try { await api("/api/web-logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch (e) { /* the key is forgotten here anyway */ }
    session = null;
    write("localStorage", SESSION, null);
    location.reload();
  }
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest("[data-hoh-login]")) { e.preventDefault(); e.stopPropagation(); closeLogin(); startLogin(); }
    else if (t.closest("[data-hoh-logout]")) { e.preventDefault(); e.stopPropagation(); logout(); }
  }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) check(); });
  // back from Telegram after the phone reloaded the tab: keep waiting for the same code
  const pending = read("sessionStorage", PENDING);
  if (pending && !session && pending.code && Date.parse(pending.expires_at) > Date.now()) {
    const go = () => { showLogin(pending); check(); };
    if (document.body) go(); else document.addEventListener("DOMContentLoaded", go);
  } else if (pending) write("sessionStorage", PENDING, null);

  // a session that ended on the server (signed out elsewhere, 180 days passed): forget it and start as a guest
  if (session) {
    api("/api/web-session").then((d) => {
      if (d && d.user) { session.user = d.user; write("localStorage", SESSION, session); }
    }).catch((e) => {
      if (e && e.status === 401) { session = null; write("localStorage", SESSION, null); location.reload(); }
    });
  }

  // ---- the account card: at the top of «Мои» and in the profile settings ------------------------------------------------------
  function accountHtml() {
    if (!session) return `<b>Войдите через Telegram</b><p>Прогнозы, очки, подписки, вопросы ведущим и достижения будут общими с приложением в Telegram.</p>${button()}`;
    const u = session.user || {};
    const who = [u.first_name, u.username ? "@" + u.username : ""].filter(Boolean).join(" ");
    return `<b>Вы вошли через Telegram</b><p>${who ? esc(who) + " — " : ""}всё общее с приложением в Telegram.</p><button class="hohOut" type="button" data-hoh-logout>Выйти на этом устройстве</button>`;
  }
  function mountAccount() {
    const view = document.getElementById("view");
    if (!view) return;
    const settings = view.querySelector(".v22Settings");
    const mine = view.querySelector(":scope > #v15Theme");
    const target = settings || (mine ? view : null);
    let card = document.getElementById("hohAccount");
    if (!target) { if (card) card.remove(); return; }
    if (card && target.contains(card)) return;
    if (card) card.remove();
    card = document.createElement("section");
    card.id = "hohAccount";
    card.className = "hohAccount";
    card.innerHTML = accountHtml();
    if (settings) settings.appendChild(card); else mine.before(card);
  }
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; mountAccount(); }, 120); };
  const watch = () => { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); schedule(); };
  if (document.body) watch(); else document.addEventListener("DOMContentLoaded", watch);
}
