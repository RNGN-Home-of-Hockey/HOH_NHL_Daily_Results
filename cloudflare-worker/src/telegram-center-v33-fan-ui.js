// Live Center v33 on the screen:
//   - the first visit (in Telegram, nothing followed yet): three short steps — the favourite team, its players, what the person
//     likes; the answers are the usual follows, so the home page puts the team first by itself;
//   - «Достижения» on the «Мои» screen, with easy first steps;
//   - the counting behind them: the app opened today, a broadcast opened, a fresh news opened.
// This function is serialized (fanApp.toString()) and served as /telegram-app/v33-fan.js: it must be self-contained.
export function fanApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV33) return;
  const F = (window.HOHV33 = {});
  const API = "/api/telegram-center-v33";
  const V2 = H.V2 || "/api/telegram-center-v2";
  const KEY_DONE = "hoh-onboard-v1";
  const KEY_OPEN = "hoh-open-day";
  const KEY_INTERESTS = "hoh-interests";
  const MAX_PLAYERS = 5;
  const INTERESTS = [["results", "Результаты и голы"], ["streams", "Трансляции матчей"], ["bets", "Прогнозы и ставки"]];
  const st = { me: null, meAt: 0, meBusy: false, sheet: null, teams: null, stars: new Map(), pick: { team: null, players: new Set(), interests: new Set() }, step: 1, saving: false };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inTelegram = () => Boolean(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
  // signed in: inside Telegram, or on the website through «Войти через Telegram» (telegram-center-web-login-ui.js)
  const signedIn = () => inTelegram() || Boolean(window.HOHAuth && window.HOHAuth.signedIn());
  const webGuest = () => !signedIn() && Boolean(window.HOHAuth);
  const store = {
    get: (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  const moscowDay = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

  function css() {
    if (document.getElementById("v33css")) return;
    const style = document.createElement("style");
    style.id = "v33css";
    style.textContent = `
.v33Shade{position:fixed;inset:0;z-index:90;display:flex;align-items:flex-end;justify-content:center;background:rgba(8,6,20,.55)}
.v33Sheet{width:min(560px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:22px 22px 0 0;background:#fff;color:#14121f;overflow:hidden}
.v33Body{flex:1 1 auto;min-height:0;overflow:auto;display:grid;align-content:start;gap:12px;padding:18px 16px 12px}
html:not(.v15Light) .v33Sheet{background:#151724;color:#f4f4f8}
.v33Step{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#7a3df0}
.v33Sheet h3{margin:0;font-size:21px;font-weight:900;line-height:1.2}
.v33Sheet p{margin:0;font-size:13.5px;opacity:.75;font-weight:600}
.v33Teams{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.v33Team{display:grid;justify-items:center;gap:4px;padding:8px 4px;border:1.5px solid rgba(122,61,240,.18);border-radius:14px;background:none;color:inherit;font:inherit;font-size:11px;font-weight:700;cursor:pointer;text-align:center;line-height:1.15}
.v33Team img{width:34px;height:34px;object-fit:contain}
.v33Team.on{border-color:#7a3df0;background:rgba(122,61,240,.12)}
.v33Players{display:grid;gap:6px}
.v33Player{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 10px;border:1.5px solid rgba(122,61,240,.18);border-radius:14px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.v33Player img{width:40px;height:40px;border-radius:50%;object-fit:cover;background:rgba(122,61,240,.1)}
.v33Player b{display:block;font-size:14px;font-weight:800}
.v33Player small{font-size:12px;opacity:.7;font-weight:600}
.v33Player i{font-style:normal;font-size:18px;font-weight:900;color:#7a3df0}
.v33Player.on{border-color:#7a3df0;background:rgba(122,61,240,.1)}
.v33Chips{display:grid;gap:8px}
.v33Chip{padding:12px 14px;border:1.5px solid rgba(122,61,240,.22);border-radius:14px;background:none;color:inherit;font:inherit;font-size:15px;font-weight:800;text-align:left;cursor:pointer}
.v33Chip.on{border-color:#7a3df0;background:rgba(122,61,240,.12)}
.v33Btns{flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:10px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid rgba(122,61,240,.12)}
.v33Go{flex:1;padding:13px 16px;border:0;border-radius:14px;background:#7a3df0;color:#fff;font:inherit;font-size:15px;font-weight:900;cursor:pointer}
.v33Go[disabled]{opacity:.5}
.v33Skip{padding:13px 10px;border:0;background:none;color:inherit;opacity:.65;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
.v33Toast{position:fixed;left:50%;bottom:24px;z-index:95;transform:translateX(-50%);padding:11px 16px;border-radius:14px;background:#14121f;color:#fff;font-size:14px;font-weight:800;box-shadow:0 10px 30px -10px rgba(0,0,0,.5)}
.v33Ach{display:grid;gap:10px;margin:0 0 12px;padding:16px;border:1px solid var(--v29-line,#d9dbe6);border-radius:20px;background:var(--v29-card,rgba(255,255,255,.82))}
html:not(.v15Light) .v33Ach{border-color:#30334a;background:rgba(16,18,26,.8);color:#f7f7fb}
.v33AchHead{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.v33AchHead b{font-size:16px;font-weight:800}
.v33AchHead button{padding:0;border:0;background:none;color:#7a3df0;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.v33Grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.v33Badge{display:grid;gap:4px;padding:10px;border-radius:14px;background:rgba(122,61,240,.08)}
.v33Badge.done{background:linear-gradient(135deg,rgba(122,61,240,.18),rgba(255,90,0,.14))}
.v33Badge .t{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:800;line-height:1.15}
.v33Badge .t span{font-size:18px}
.v33Badge .s{font-size:12px;letter-spacing:1px;color:#ff5a00}
.v33Badge .h{font-size:11px;opacity:.7;font-weight:600;line-height:1.25}
.v33Badge .bar{height:5px;border-radius:99px;background:rgba(122,61,240,.14);overflow:hidden}
.v33Badge .bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#7a3df0,#ff5a00)}
.v27Home.v33HeroUp:not(.v32LiveFirst)>[data-sec="hero"]{order:2!important}
.v27Home.v33HeroUp:not(.v32LiveFirst)>[data-sec="russians"]{order:3!important}
.v27Home.v33HeroUp:not(.v32LiveFirst)>[data-sec="goals"]{order:4!important}
`;
    document.head.appendChild(style);
  }

  // ---- the counting behind the achievements ----------------------------------------------------------------------------------
  function track(kind, extra) {
    if (!signedIn()) return;
    Promise.resolve(H.api(`${API}/activity`, { method: "POST", body: JSON.stringify({ kind, ...(extra || {}) }) })).then(() => { st.meAt = 0; }).catch(() => {});
  }
  function trackOpen() {
    const day = moscowDay();
    if (store.get(KEY_OPEN) === day) return;
    store.set(KEY_OPEN, day);
    track("open");
  }
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const vk = t.closest('a[href*="vkvideo.ru"],a[href*="vk.com/video"]');
    if (vk) track("stream");
    const news = t.closest("[data-v27-news]");
    if (news && Number(news.dataset.v27News) > 0) track("news", { news_id: Number(news.dataset.v27News) });
  }, true);

  // ---- what the person likes: the order of the home page ------------------------------------------------------------------------
  function interests() {
    try {
      const v = JSON.parse(store.get(KEY_INTERESTS) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  // «Трансляции» or «Прогнозы и ставки» without «Результаты»: the match of the day comes before the goals
  function applyInterests() {
    const home = document.querySelector("#view .v27Home");
    if (!home) return;
    const list = interests();
    home.classList.toggle("v33HeroUp", !list.includes("results") && (list.includes("streams") || list.includes("bets")));
  }

  // ---- the first visit -------------------------------------------------------------------------------------------------------------
  // the city is enough on a logo, unless two teams share it (Нью-Йорк Айлендерс / Рейнджерс): then the name of the club
  function shortName(t) {
    const words = String(t.name_ru || t.tri).split(" ");
    const city = words[0];
    const twins = (st.teams || []).filter((x) => String(x.name_ru || "").split(" ")[0] === city).length > 1;
    return twins && words.length > 1 ? words.slice(1).join(" ") : city;
  }
  function sheetHtml() {
    const p = st.pick;
    if (st.step === 1) {
      const teams = st.teams ? st.teams.map((t) => `<button type="button" class="v33Team${p.team === t.tri ? " on" : ""}" data-v33-team="${esc(t.tri)}"><img src="${esc(t.logo)}" alt="">${esc(shortName(t))}</button>`).join("") : "<p>Загрузка…</p>";
      return `<div class="v33Body"><div class="v33Step">Шаг 1 из 3</div><h3>Знакомимся! За какую команду болеете?</h3><p>Её матчи, голы и новости будут первыми.</p><div class="v33Teams">${teams}</div></div><div class="v33Btns"><button type="button" class="v33Skip" data-v33-skip>Пропустить</button><button type="button" class="v33Go" data-v33-next${p.team ? "" : " disabled"}>Дальше</button></div>`;
    }
    if (st.step === 2) {
      const list = st.stars.get(p.team);
      const players = list ? list.map((x) => `<button type="button" class="v33Player${p.players.has(x.player_id) ? " on" : ""}" data-v33-player="${esc(x.player_id)}"><img src="${esc(x.photo)}" alt="" loading="lazy"><span><b>${esc(x.name)}</b> <small>${esc(x.goals)} г + ${esc(x.points - x.goals)} п в сезоне</small></span><i>${p.players.has(x.player_id) ? "✓" : "+"}</i></button>`).join("") : "<p>Загрузка…</p>";
      return `<div class="v33Body"><div class="v33Step">Шаг 2 из 3</div><h3>Любимые игроки</h3><p>Выберите до ${MAX_PLAYERS} — их голы и новости будут первыми.</p><div class="v33Players">${players}</div></div><div class="v33Btns"><button type="button" class="v33Skip" data-v33-back>Назад</button><button type="button" class="v33Go" data-v33-next>${p.players.size ? "Дальше" : "Без игроков"}</button></div>`;
    }
    const chips = INTERESTS.map(([k, t]) => `<button type="button" class="v33Chip${p.interests.has(k) ? " on" : ""}" data-v33-int="${k}">${p.interests.has(k) ? "✓ " : ""}${esc(t)}</button>`).join("");
    return `<div class="v33Body"><div class="v33Step">Шаг 3 из 3</div><h3>Что вам интереснее?</h3><p>Можно выбрать несколько — главная подстроится.</p><div class="v33Chips">${chips}</div></div><div class="v33Btns"><button type="button" class="v33Skip" data-v33-back>Назад</button><button type="button" class="v33Go" data-v33-done${st.saving ? " disabled" : ""}>${st.saving ? "Сохраняем…" : "Готово"}</button></div>`;
  }
  function paintSheet() {
    if (!st.sheet) return;
    const old = st.sheet.querySelector(".v33Body");
    const top = old && old.dataset.step === String(st.step) ? old.scrollTop : 0;
    st.sheet.querySelector(".v33Sheet").innerHTML = sheetHtml();
    const body = st.sheet.querySelector(".v33Body");
    if (body) {
      body.dataset.step = String(st.step);
      body.scrollTop = top;
    }
  }
  async function openSheet() {
    if (st.sheet) return;
    st.step = 1;
    st.pick = { team: null, players: new Set(), interests: new Set(interests()) };
    const shade = document.createElement("div");
    shade.className = "v33Shade";
    shade.innerHTML = '<div class="v33Sheet" role="dialog" aria-label="Знакомство"></div>';
    document.body.appendChild(shade);
    st.sheet = shade;
    paintSheet();
    if (!st.teams) {
      try {
        const d = await H.api(`${API}/onboarding`);
        st.teams = (d && d.teams) || [];
      } catch (e) {
        st.teams = [];
      }
      paintSheet();
    }
  }
  F.open = openSheet;
  function closeSheet() {
    if (st.sheet) st.sheet.remove();
    st.sheet = null;
  }
  async function loadStars(tri) {
    if (st.stars.has(tri)) return;
    try {
      const d = await H.api(`${API}/teams/${encodeURIComponent(tri)}/stars`);
      st.stars.set(tri, (d && d.players) || []);
    } catch (e) {
      st.stars.set(tri, []);
    }
    paintSheet();
  }
  function toast(text) {
    const t = document.createElement("div");
    t.className = "v33Toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  async function finish(skipped) {
    if (st.saving) return;
    st.saving = true;
    paintSheet();
    const p = st.pick;
    try {
      if (!skipped) {
        if (p.team) await Promise.resolve(H.api(`${V2}/subscriptions`, { method: "POST", body: JSON.stringify({ type: "team", key: p.team }) })).catch(() => null);
        for (const id of p.players) await Promise.resolve(H.api(`${V2}/subscriptions`, { method: "POST", body: JSON.stringify({ type: "player", key: String(id) }) })).catch(() => null);
        store.set(KEY_INTERESTS, JSON.stringify([...p.interests]));
      }
      await Promise.resolve(H.api(`${API}/me`, { method: "PUT", body: JSON.stringify(skipped ? { onboarded: true } : { interests: [...p.interests], onboarded: true }) })).catch(() => null);
    } finally {
      store.set(KEY_DONE, "1");
      st.saving = false;
      st.meAt = 0;
      closeSheet();
      window.dispatchEvent(new Event("hoh-follows-change"));
      applyInterests();
      if (!skipped) toast("Готово! Главная настроена под вас");
    }
  }
  async function maybeOnboard() {
    if (!signedIn() || store.get(KEY_DONE) === "1" || st.sheet) return;
    if (H.currentTab && !["games", "home"].includes(H.currentTab())) return;
    const me = await loadMe();
    if (!me || me.guest) return;
    if (me.onboarded) { store.set(KEY_DONE, "1"); return; }
    // somebody who already follows teams or players set the app up long ago: not asked, only remembered
    if (Number(me.follows) > 0) {
      store.set(KEY_DONE, "1");
      Promise.resolve(H.api(`${API}/me`, { method: "PUT", body: JSON.stringify({ onboarded: true }) })).catch(() => {});
      return;
    }
    openSheet();
  }
  F.maybeOnboard = maybeOnboard;

  // ---- «Достижения» on the «Мои» screen --------------------------------------------------------------------------------------------
  async function loadMe() {
    if (st.meBusy) return st.me;
    if (st.me && Date.now() - st.meAt < 60000) return st.me;
    st.meBusy = true;
    try {
      const d = await H.api(`${API}/me`);
      st.me = d && d.ok !== false ? d : { guest: true };
      if (st.me && Array.isArray(st.me.interests) && st.me.interests.length) store.set(KEY_INTERESTS, JSON.stringify(st.me.interests));
    } catch (e) {
      st.me = { guest: true };
    } finally {
      st.meAt = Date.now();
      st.meBusy = false;
    }
    return st.me;
  }
  function badgeHtml(a) {
    const stars = "★".repeat(a.tier) + "☆".repeat(Math.max(0, a.tiers - a.tier));
    const target = a.next || a.steps[a.steps.length - 1];
    const pct = Math.max(0, Math.min(100, Math.round((100 * a.value) / target)));
    const line = a.next ? `${a.value} из ${a.next} · ${a.hint}` : `${a.value} · ${a.hint} · всё пройдено`;
    return `<div class="v33Badge${a.tier > 0 ? " done" : ""}" data-v33-badge="${esc(a.key)}"><span class="t"><span>${esc(a.icon)}</span> ${esc(a.title)}</span> <span class="s" aria-label="ступень ${a.tier} из ${a.tiers}">${stars}</span><span class="bar"><i style="width:${pct}%"></i></span> <span class="h">${esc(line)}</span></div>`;
  }
  function achHtml() {
    const me = st.me;
    if (!me || me.guest || !Array.isArray(me.achievements)) return "";
    // the ones that are going best first
    const sorted = me.achievements.slice().sort((a, b) => b.tier / b.tiers - a.tier / a.tiers);
    return `<section class="v33Ach" id="v33Ach"><div class="v33AchHead"><b>Достижения</b> <button type="button" data-v33-setup>Настроить главную</button></div><div class="v33Grid">${sorted.map(badgeHtml).join("")}</div></section>`;
  }
  function paintAch() {
    const box = document.getElementById("v29Me");
    const el = document.getElementById("v33Ach");
    const onMine = H.currentTab && ["follows", "mine"].includes(H.currentTab()) && !(H.state && H.state.profile);
    if (!box || !onMine || !signedIn()) { if (el) el.remove(); return; }
    if ((!st.me || Date.now() - st.meAt > 60000) && !st.meBusy) loadMe().then(paintAch);
    const html = achHtml();
    if (!html) { if (el) el.remove(); return; }
    if (el && el.dataset.v33Html === html) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    next.dataset.v33Html = html;
    if (el) el.replaceWith(next);
    else (document.getElementById("v34Box") || box).after(next); // under «Мои итоги» when it is there
  }

  // ---- clicks -----------------------------------------------------------------------------------------------------------------------
  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-v33-team],[data-v33-player],[data-v33-int],[data-v33-next],[data-v33-back],[data-v33-skip],[data-v33-done],[data-v33-setup]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const d = el.dataset;
    const p = st.pick;
    if (d.v33Team) { p.team = d.v33Team; p.players.clear(); paintSheet(); }
    else if (d.v33Player) {
      const id = Number(d.v33Player);
      if (p.players.has(id)) p.players.delete(id);
      else if (p.players.size < MAX_PLAYERS) p.players.add(id);
      paintSheet();
    } else if (d.v33Int) {
      if (p.interests.has(d.v33Int)) p.interests.delete(d.v33Int);
      else p.interests.add(d.v33Int);
      paintSheet();
    } else if (d.v33Next !== undefined) {
      if (st.step === 1 && !p.team) return;
      st.step = Math.min(3, st.step + 1);
      if (st.step === 2) loadStars(p.team);
      paintSheet();
    } else if (d.v33Back !== undefined) { st.step = Math.max(1, st.step - 1); paintSheet(); }
    else if (d.v33Skip !== undefined) finish(true);
    else if (d.v33Done !== undefined) finish(false);
    else if (d.v33Setup !== undefined) openSheet();
  }, true);

  // ---- wiring ---------------------------------------------------------------------------------------------------------------------
  F.state = st;
  F.paint = () => { applyInterests(); paintAch(); };
  css();
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; applyInterests(); paintAch(); }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  }
  trackOpen();
  applyInterests();
  setTimeout(maybeOnboard, 1500);
}
