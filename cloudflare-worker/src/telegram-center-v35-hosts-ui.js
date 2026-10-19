// Live Center v35 on the screen («Мои»): the hosts of Home of Hockey with their picks, «Сравнить со мной», «Зрители против
// ведущих» of the week, and «Задай вопрос комментаторам» with the date of the answers on air. Since 2026-10-19 the hosts are called the
// commentators of HOH on the screen (the owner) and only those who made picks are listed (the whole chat of the commentators is in).
// This function is serialized (hostsApp.toString()) and served as /telegram-app/v35-hosts.js: it must be self-contained.
export function hostsApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV35) return;
  const V = (window.HOHV35 = {});
  const API = "/api/telegram-center-v35";
  const MAX = 300;
  const st = { hosts: null, hostsAt: 0, mine: null, mineAt: 0, busy: new Set(), compare: new Map(), draft: "", sending: false, note: "" };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inTelegram = () => Boolean(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
  // signed in: inside Telegram, or on the website through «Войти через Telegram» (telegram-center-web-login-ui.js)
  const signedIn = () => inTelegram() || Boolean(window.HOHAuth && window.HOHAuth.signedIn());
  const webGuest = () => !signedIn() && Boolean(window.HOHAuth);
  const onMine = () => H.currentTab && ["follows", "mine"].includes(H.currentTab()) && !(H.state && H.state.profile);
  const STATUS = { new: "отправлен", picked: "выбран для эфира 🎙", answered: "отвечен в эфире ✅" };

  function css() {
    if (document.getElementById("v35css")) return;
    const style = document.createElement("style");
    style.id = "v35css";
    style.textContent = `
.v35Card{display:grid;gap:10px;margin:0 0 12px;padding:16px;border:1px solid var(--v29-line,#d9dbe6);border-radius:20px;background:var(--v29-card,rgba(255,255,255,.82))}
html:not(.v15Light) .v35Card{border-color:#30334a;background:rgba(16,18,26,.8);color:#f7f7fb}
.v35Card>b{font-size:16px;font-weight:900}
.v35Note{font-size:12.5px;font-weight:600;opacity:.75;line-height:1.35}
.v35Vs{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:10px 12px;border-radius:14px;background:linear-gradient(120deg,rgba(122,61,240,.16),rgba(255,90,0,.14))}
.v35Vs div{display:grid;justify-items:center;gap:2px}
.v35Vs strong{font-size:24px;font-weight:900}
.v35Vs span{font-size:11.5px;font-weight:700;opacity:.75}
.v35Vs em{font-style:normal;font-size:12px;font-weight:900;color:#ff5a00}
.v35Host{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid rgba(122,61,240,.12)}
.v35Av{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#7a3df0;color:#fff;font-weight:900}
.v35Host b{display:block;font-size:14.5px;font-weight:800}
.v35Host small{display:block;font-size:12px;font-weight:600;opacity:.75}
.v35Host button{padding:7px 10px;border:1px solid #7a3df0;border-radius:10px;background:none;color:#7a3df0;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}
html:not(.v15Light) .v35Host button{color:#c4a6ff;border-color:#8b5cf6}
.v35Cmp{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:6px}
.v35Cmp div{display:grid;gap:2px;padding:8px 10px;border-radius:12px;background:rgba(122,61,240,.08)}
.v35Cmp strong{font-size:17px;font-weight:900}
.v35Cmp span{font-size:11.5px;font-weight:700;opacity:.75}
.v35Cmp p{grid-column:1/-1;margin:0;font-size:12.5px;font-weight:700}
.v35Ask textarea{width:100%;min-height:72px;resize:vertical;padding:10px;border:1px solid var(--v29-line,#d9dbe6);border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:14px;box-sizing:border-box}
.v35Row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.v35Row small{font-size:11.5px;opacity:.65;font-weight:600}
.v35Send{padding:10px 16px;border:0;border-radius:12px;background:#7a3df0;color:#fff;font:inherit;font-size:14px;font-weight:900;cursor:pointer}
.v35Send[disabled]{opacity:.5}
.v35Ama{padding:8px 10px;border-radius:12px;background:rgba(255,90,0,.12);font-size:13px;font-weight:800}
.v35Mine{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.v35Mine li{display:grid;gap:2px;padding:8px 10px;border-radius:12px;background:rgba(122,61,240,.07);font-size:13px}
.v35Mine li small{font-size:11.5px;font-weight:800;color:#7a3df0}
`;
    document.head.appendChild(style);
  }

  // ---- the hosts ---------------------------------------------------------------------------------------------------------------
  function contestHtml(c) {
    if (!c) return "";
    const lead = c.leader === "fans" ? "Ведут зрители!" : c.leader === "hosts" ? "Ведут комментаторы" : "Ничья";
    return `<div class="v35Vs" data-v35-contest><div><strong>${esc(c.fans.accuracy)}%</strong> <span>зрители · ${esc(c.fans.players)}</span></div> <em>${esc(lead)}</em> <div><strong>${esc(c.hosts.accuracy)}%</strong> <span>комментаторы · ${esc(c.hosts.players)}</span></div></div>`;
  }
  function compareHtml(h) {
    const c = st.compare.get(h.id);
    if (!c) return "";
    if (c.loading) return '<div class="v35Cmp"><p>Сравниваем…</p></div>';
    if (c.error) return '<div class="v35Cmp"><p>' + (window.HOHAuth && !inTelegram() ? 'Войдите через Telegram, чтобы сравнить.' : 'Сравнение доступно в приложении, открытом из Telegram-бота.') + '</p></div>';
    const a = (x) => (x.accuracy == null ? "—" : `${x.accuracy}%`);
    const agree = c.common ? `Общих прогнозов: ${c.common}, совпали ${c.agree}` : "Общих прогнозов пока нет — голосуйте за те же матчи";
    return `<div class="v35Cmp"><div><strong>${esc(a(c.me))}</strong> <span>вы · ${esc(c.me.correct)} из ${esc(c.me.settled)}</span></div><div><strong>${esc(a(c.host))}</strong> <span>${esc(h.name)} · ${esc(c.host.correct)} из ${esc(c.host.settled)}</span></div><p>${esc(agree)}</p></div>`;
  }
  function hostRow(h) {
    const acc = h.accuracy == null ? "пока без рассчитанных прогнозов" : `угадано ${h.correct} из ${h.settled} · ${h.accuracy}%`;
    const picks = h.picks && h.picks.length ? `Сейчас за: ${h.picks.map((p) => `${p.tri} (${p.game})`).join(", ")}` : "";
    return `<div class="v35Host" data-v35-host="${esc(h.id)}"><span class="v35Av">${esc(String(h.name || "?").slice(0, 1).toUpperCase())}</span><span><b>${esc(h.name)}</b> <small>Ур. ${esc(h.level)} · ${esc(acc)}</small>${picks ? ` <small>${esc(picks)}</small>` : ""}</span>${signedIn() ? `<button type="button" data-v35-compare="${esc(h.id)}">${st.compare.has(h.id) ? "Скрыть" : "Сравнить со мной"}</button>` : ""}${compareHtml(h)}</div>`;
  }
  function hostsHtml() {
    const d = st.hosts;
    if (!d) return "";
    const list = d.hosts || [];
    const body = list.length ? list.map(hostRow).join("") : '<div class="v35Note">Как только комментаторы HOH сделают прогнозы, здесь можно будет сравнить свои прогнозы с их.</div>';
    return `<section class="v35Card" id="v35Hosts"><b>🎙 Комментаторы HOH</b>${list.length ? ' <span class="v35Note">Их прогнозы видны всем. Кто угадывает лучше — зрители или комментаторы?</span>' : ""}${contestHtml(d.contest)}${body}</section>`;
  }

  // ---- the questions -----------------------------------------------------------------------------------------------------------
  function askHtml() {
    if (!signedIn()) return webGuest() ? `<section class="v35Card v35Ask" id="v35Ask"><b>Задай вопрос комментаторам</b>${window.HOHAuth.needLogin("Войдите через Telegram, чтобы задать вопрос комментаторам и сравнить свои прогнозы с их прогнозами.")}</section>` : "";
    const m = st.mine || { questions: [], ama: null };
    const left = MAX - st.draft.length;
    const mine = (m.questions || []).length ? `<ul class="v35Mine">${m.questions.map((q) => `<li>${esc(q.text)} <small>${esc(STATUS[q.status] || q.status)}</small></li>`).join("")}</ul>` : "";
    return `<section class="v35Card v35Ask" id="v35Ask"><b>Задай вопрос комментаторам</b>${m.ama ? ` <div class="v35Ama">🎙 Ответы в эфире: ${esc(m.ama)}</div>` : ""} <span class="v35Note">Лучшие вопросы комментаторы разберут в эфире. Вопросы болельщиков с высоким уровнем — выше в списке.</span><textarea data-v35-text maxlength="${MAX}" placeholder="Ваш вопрос…">${esc(st.draft)}</textarea><div class="v35Row"><small>${st.note ? esc(st.note) : `осталось ${left} знаков`}</small><button type="button" class="v35Send" data-v35-send${st.sending || st.draft.trim().length < 5 ? " disabled" : ""}>${st.sending ? "Отправляем…" : "Отправить"}</button></div>${mine}</section>`;
  }

  // ---- loading and painting ------------------------------------------------------------------------------------------------------
  async function loadHosts() {
    if (st.busy.has("hosts")) return;
    st.busy.add("hosts");
    try {
      const d = await H.api(`${API}/hosts`);
      if (d && d.ok !== false) st.hosts = d;
    } catch (e) {
      if (!st.hosts) st.hosts = { hosts: [], contest: null };
    } finally {
      st.hostsAt = Date.now();
      st.busy.delete("hosts");
      paint(true);
    }
  }
  async function loadMine() {
    if (st.busy.has("mine") || !signedIn()) return;
    st.busy.add("mine");
    try {
      const d = await H.api(`${API}/questions`);
      if (d && d.ok !== false) st.mine = d;
    } catch (e) {
      st.mine = st.mine || { questions: [], ama: null };
    } finally {
      st.mineAt = Date.now();
      st.busy.delete("mine");
      paint(true);
    }
  }
  function place(id, html, anchor) {
    const el = document.getElementById(id);
    if (!html) { if (el) el.remove(); return null; }
    if (el && el.dataset.v35Html === html) return el;
    const box = document.createElement("div");
    box.innerHTML = html;
    const next = box.firstElementChild;
    next.dataset.v35Html = html;
    if (el) el.replaceWith(next);
    else if (anchor) anchor.after(next);
    return next;
  }
  function paint(force) {
    const me = document.getElementById("v29Me");
    if (!me || !onMine()) {
      ["v35Hosts", "v35Ask"].forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); });
      return;
    }
    if (!st.busy.has("hosts") && (!st.hosts || Date.now() - st.hostsAt > 120000)) loadHosts();
    if (signedIn() && !st.busy.has("mine") && (!st.mine || Date.now() - st.mineAt > 120000)) loadMine();
    // the text being typed is never redrawn under the fingers
    const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches("[data-v35-text]");
    const after = document.getElementById("v33Ach") || document.getElementById("v34Box") || me;
    const hostsEl = place("v35Hosts", hostsHtml(), after);
    if (!typing || force === "ask") place("v35Ask", askHtml(), hostsEl || after);
  }
  V.paint = paint;
  V.state = st;

  async function toggleCompare(id) {
    if (st.compare.has(id)) { st.compare.delete(id); paint(true); return; }
    st.compare.set(id, { loading: true });
    paint(true);
    try {
      const d = await H.api(`${API}/hosts/${encodeURIComponent(id)}/compare`);
      st.compare.set(id, d && d.ok !== false ? d : { error: true });
    } catch (e) {
      st.compare.set(id, { error: true });
    }
    paint(true);
  }
  async function send() {
    const text = st.draft.trim();
    if (st.sending || text.length < 5) return;
    st.sending = true;
    st.note = "";
    paint("ask");
    try {
      await H.api(`${API}/questions`, { method: "POST", body: JSON.stringify({ text }) });
      st.draft = "";
      st.note = "Вопрос отправлен ✅";
      st.mineAt = 0;
      loadMine();
    } catch (error) {
      st.note = /too_many/.test(String(error && error.message)) ? "Не больше 3 вопросов в день" : "Не получилось — попробуйте ещё раз";
    } finally {
      st.sending = false;
      paint("ask");
    }
  }

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches("[data-v35-text]")) return;
    st.draft = String(t.value || "").slice(0, MAX);
    st.note = "";
    const box = document.getElementById("v35Ask");
    const small = box && box.querySelector(".v35Row small");
    const btn = box && box.querySelector("[data-v35-send]");
    if (small) small.textContent = `осталось ${MAX - st.draft.length} знаков`;
    if (btn) btn.disabled = st.sending || st.draft.trim().length < 5;
  });
  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-v35-compare],[data-v35-send]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (el.dataset.v35Compare) toggleCompare(Number(el.dataset.v35Compare));
    else send();
  }, true);

  css();
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; paint(); }, 150);
    }).observe(document.body, { childList: true, subtree: true });
  }
  paint();
}
