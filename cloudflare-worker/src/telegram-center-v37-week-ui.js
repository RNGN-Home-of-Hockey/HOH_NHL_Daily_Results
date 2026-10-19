// Live Center v37 on the screen: «Вопрос недели» on the home (under the match of the day) and in «Мои». One tap answers (a team logo
// or a variant); after the answer — the split with the logos and the commentators of HOH marked 🎙; an admin gets the picture for the
// social networks (the owner: «сделаем графику с прогнозов»).
// This function is serialized (weekApp.toString()) and served as /telegram-app/v37-week.js: it must be self-contained.
export function weekApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV37) return;
  const V = (window.HOHV37 = {});
  const API = "/api/telegram-center-v37";
  const TOP = 5;
  const st = { d: null, at: 0, busy: false, sending: false, pick: false, change: false, all: false, note: "", picture: null };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inTelegram = () => Boolean(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
  const signedIn = () => inTelegram() || Boolean(window.HOHAuth && window.HOHAuth.signedIn());
  const tab = () => (H.currentTab ? H.currentTab() : "");
  const inside = () => Boolean(H.state && H.state.profile);
  const surname = (name) => String(name || "").trim().split(/\s+/).pop();
  const answersWord = (n) => { const x = Math.abs(n) % 100, y = x % 10; return x > 10 && x < 20 ? "ответов" : y === 1 ? "ответ" : y >= 2 && y <= 4 ? "ответа" : "ответов"; };

  function css() {
    if (document.getElementById("v37css")) return;
    const style = document.createElement("style");
    style.id = "v37css";
    style.textContent = `
.v37Week{display:grid;gap:12px;margin:0 0 14px;padding:16px;border-radius:22px;border:1px solid #d8c7fb;background:linear-gradient(150deg,#ffffff 0%,#f4eefe 100%);color:#1d1b2b;box-shadow:0 12px 28px -22px rgba(91,33,182,.6)}
html:not(.v15Light) .v37Week{border-color:#3a2d63;background:linear-gradient(150deg,#16121f 0%,#1f1636 100%);color:#f6f3ff}
.v37Top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.v37Tag{padding:5px 10px;border-radius:999px;background:linear-gradient(90deg,#7a3df0,#ff5a00);color:#fff;font-size:11px;font-weight:900;letter-spacing:.6px}
.v37Count{font-size:12px;font-weight:700;opacity:.7}
.v37Q{font-size:19px;font-weight:900;line-height:1.25}
.v37Line{font-size:13px;font-weight:700;opacity:.8}
.v37Line.ok{color:#127a52;opacity:1}
html:not(.v15Light) .v37Line.ok{color:#62e6ae}
.v37Teaser{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:12px;background:rgba(122,61,240,.1);font-size:13px;font-weight:700}
.v37Open{min-height:46px;border:0;border-radius:14px;background:#1d1b2b;color:#fff;font:inherit;font-size:15px;font-weight:900;cursor:pointer}
html:not(.v15Light) .v37Open{background:#f4f1fa;color:#151721}
.v37Grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.v37Team{display:grid;justify-items:center;gap:4px;padding:8px 2px;border:1px solid rgba(122,61,240,.18);border-radius:12px;background:rgba(255,255,255,.7);color:inherit;font:inherit;font-size:11px;font-weight:800;cursor:pointer;min-width:0}
html:not(.v15Light) .v37Team{background:rgba(255,255,255,.05);border-color:#3a2d63}
.v37Team img{width:34px;height:34px;object-fit:contain}
.v37Team span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v37Team.mine,.v37Var.mine{border-color:#ff5a00;box-shadow:inset 0 0 0 1px #ff5a00}
.v37Vars{display:grid;gap:6px}
.v37Var{min-height:44px;padding:8px 12px;border:1px solid rgba(122,61,240,.25);border-radius:12px;background:rgba(255,255,255,.7);color:inherit;font:inherit;font-size:14px;font-weight:800;text-align:left;cursor:pointer}
html:not(.v15Light) .v37Var{background:rgba(255,255,255,.05);border-color:#3a2d63}
.v37Res{display:grid;gap:8px}
.v37Row{display:grid;grid-template-columns:28px minmax(0,1fr) 44px;gap:8px;align-items:center}
.v37Row img{width:26px;height:26px;object-fit:contain}
.v37Row .v37Dot{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:rgba(122,61,240,.15);font-size:12px;font-weight:900}
.v37Bar{position:relative;display:grid;gap:3px;min-width:0}
.v37Bar b{font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v37Bar i{display:block;height:7px;border-radius:99px;background:rgba(122,61,240,.14);overflow:hidden}
.v37Bar i span{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#7a3df0,#ff5a00)}
.v37Bar small{font-size:11.5px;font-weight:700;color:#7a3df0}
html:not(.v15Light) .v37Bar small{color:#c4a6ff}
.v37Row strong{text-align:right;font-size:16px;font-weight:900}
.v37Row.mine b:after{content:" · ваш ответ";font-size:11px;font-weight:800;color:#ff5a00}
.v37Row.right b:after{content:" ✓ правильный";font-size:11px;font-weight:900;color:#17a06b}
.v37More{justify-self:start;padding:0;border:0;background:none;color:#7a3df0;font:inherit;font-size:13px;font-weight:800;cursor:pointer}
.v37Hosts{display:grid;gap:6px;padding:10px 12px;border-radius:14px;background:rgba(255,90,0,.08)}
.v37Hosts>b{font-size:12px;font-weight:900;letter-spacing:.4px;text-transform:uppercase}
.v37Chips{display:flex;flex-wrap:wrap;gap:6px}
.v37Chip{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:999px;background:rgba(255,255,255,.75);font-size:12.5px;font-weight:800}
html:not(.v15Light) .v37Chip{background:rgba(255,255,255,.08)}
.v37Mic{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#ff5a00;color:#fff;font-size:10px}
.v37Acts{display:flex;flex-wrap:wrap;gap:8px}
.v37Act{padding:9px 12px;border:1px solid rgba(122,61,240,.35);border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:800;cursor:pointer}
.v37Note{font-size:12.5px;font-weight:700;color:#c2410c}
.v37Shade{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:16px;background:rgba(10,8,18,.82)}
.v37Pic{display:grid;gap:10px;max-width:420px;width:100%}
.v37Pic img{width:100%;height:auto;border-radius:16px}
.v37Pic p{margin:0;color:#fff;font-size:13px;font-weight:600;text-align:center;opacity:.85}
.v37Pic .v37Acts{justify-content:center}
.v37Pic .v37Act,.v37Pic a.v37Act{color:#fff;border-color:rgba(255,255,255,.5);text-decoration:none}
`;
    document.head.appendChild(style);
  }

  // ---- the card -------------------------------------------------------------------------------------------------------------------
  function optionHtml(o, my) {
    const mine = my === o.key ? " mine" : "";
    if (o.logo) return `<button type="button" class="v37Team${mine}" data-v37-answer="${esc(o.key)}" aria-label="${esc(o.label)}"><img src="${esc(o.logo)}" alt=""><span>${esc(o.label)}</span></button>`;
    return `<button type="button" class="v37Var${mine}" data-v37-answer="${esc(o.key)}">${esc(o.label)}</button>`;
  }
  function pickHtml(q) {
    const teams = q.options.filter((o) => o.logo);
    const vars = q.options.filter((o) => !o.logo);
    const grid = teams.length ? (st.pick ? `<div class="v37Grid">${teams.map((o) => optionHtml(o, q.my)).join("")}</div>` : `<button type="button" class="v37Open" data-v37-open>Выбрать команду ▾</button>`) : "";
    const list = vars.length && (st.pick || !teams.length) ? `<div class="v37Vars">${vars.map((o) => optionHtml(o, q.my)).join("")}</div>` : "";
    return grid + list;
  }
  function resultsHtml(q) {
    const rows = q.results || [];
    const shown = st.all ? rows : rows.slice(0, TOP);
    const row = (r) => {
      const cls = `v37Row${q.my === r.key ? " mine" : ""}${q.answer === r.key ? " right" : ""}`;
      const pic = r.logo ? `<img src="${esc(r.logo)}" alt="">` : `<span class="v37Dot">${esc(String(r.label).slice(0, 1))}</span>`;
      const hosts = r.commentators.length ? `<small>🎙 ${esc(r.commentators.map((c) => surname(c.name)).join(", "))}</small>` : "";
      return `<div class="${cls}" data-v37-row="${esc(r.key)}">${pic}<span class="v37Bar"><b>${esc(r.label)}</b><i><span style="width:${Math.max(2, r.pct)}%"></span></i>${hosts}</span><strong>${esc(r.pct)}%</strong></div>`;
    };
    const more = rows.length > TOP ? `<button type="button" class="v37More" data-v37-all>${st.all ? "Свернуть ▴" : `Ещё ${rows.length - TOP} ▾`}</button>` : "";
    return rows.length ? `<div class="v37Res">${shown.map(row).join("")}${more}</div>` : '<div class="v37Line">Пока никто не ответил — будьте первым.</div>';
  }
  function hostsHtml(q) {
    const list = q.commentators || [];
    if (!list.length) return "";
    return `<div class="v37Hosts" data-v37-hosts><b>🎙 Комментаторы HOH</b> <div class="v37Chips">${list.map((c) => `<span class="v37Chip" data-v37-host="${esc(c.id)}"><span class="v37Mic" aria-hidden="true">🎙</span>${esc(c.name)} — ${esc(c.label)}</span>`).join("")}</div></div>`;
  }
  function cardHtml() {
    const d = st.d;
    const q = d && d.question;
    if (!q) return "";
    const open = q.status === "open";
    const answering = open && (!q.my || st.change);
    let status = "";
    if (q.status === "closed") status = '<div class="v37Line">Ответы закрыты — ждём развязку.</div>';
    if (q.status === "settled") status = `<div class="v37Line${q.right ? " ok" : ""}">Ответ: ${esc(q.answer_label || "")}${q.right ? ` · ✅ Вы угадали! +${esc(q.xp)} XP` : q.my ? " · в этот раз не угадали" : ""}</div>`;
    const teaser = answering && !q.my && q.commentators_total ? `<div class="v37Teaser" data-v37-teaser><span class="v37Mic" aria-hidden="true">🎙</span>Ответили комментаторы HOH: ${esc(q.commentators_total)} — их выбор после вашего ответа</div>` : "";
    const login = st.note === "login" && window.HOHAuth ? window.HOHAuth.needLogin("Войдите через Telegram, чтобы ответить на вопрос недели.") : "";
    const note = st.note && st.note !== "login" ? `<div class="v37Note">${esc(st.note)}</div>` : "";
    const body = answering ? teaser + pickHtml(q) + login : resultsHtml(q) + hostsHtml(q);
    const acts = [];
    if (open && q.my && !st.change) acts.push('<button type="button" class="v37Act" data-v37-change>Изменить ответ</button>');
    if (d.admin && !answering) acts.push('<button type="button" class="v37Act" data-v37-picture>🖼 Картинка для соцсетей</button>');
    return `<section class="v37Week" id="v37Week" data-v37-q="${esc(q.id)}"><div class="v37Top"><span class="v37Tag">🗳 ВОПРОС НЕДЕЛИ</span><span class="v37Count">${esc(q.total)} ${esc(answersWord(q.total))}</span></div><b class="v37Q">${esc(q.text)}</b>${status}${body}${note}${acts.length ? `<div class="v37Acts">${acts.join("")}</div>` : ""}</section>`;
  }

  // ---- the picture for the social networks (admins) ----------------------------------------------------------------------------
  function wrap(ctx, text, width) {
    const words = String(text).split(/\s+/), lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > width && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  const loadImage = (src) => new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => resolve(ok ? img : null);
    const timer = setTimeout(() => done(false), 4000);
    img.onload = () => { clearTimeout(timer); done(true); };
    img.onerror = () => { clearTimeout(timer); done(false); };
    img.src = src;
  });
  async function picture() {
    const q = st.d && st.d.question;
    if (!q) return null;
    const W = 1080, Hh = 1350;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = Hh;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return null;
    const g = ctx.createLinearGradient(0, 0, W * 0.5, Hh);
    g.addColorStop(0, "#1c0b45");
    g.addColorStop(0.6, "#5b21b6");
    g.addColorStop(1, "#ff5a00");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Hh);
    const F = (weight, size) => `${weight} ${size}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.font = F(900, 34);
    ctx.fillText("HOME OF HOCKEY · ВОПРОС НЕДЕЛИ", 80, 120);
    // the question: big when it is short, smaller for a long one (up to four lines), never cut in the middle of the space below
    ctx.fillStyle = "#fff";
    ctx.font = F(900, 66);
    let lines = wrap(ctx, q.text, W - 160);
    let lineH = 78;
    if (lines.length > 3) { ctx.font = F(900, 54); lines = wrap(ctx, q.text, W - 160); lineH = 64; }
    if (lines.length > 4) lines = [...lines.slice(0, 3), `${lines[3]}…`];
    let y = 200;
    for (const line of lines) { ctx.fillText(line, 80, y); y += lineH; }
    ctx.font = F(700, 34);
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.fillText(`Ответили ${q.total} ${answersWord(q.total)}`, 80, y + 6);
    y += 66;
    // the answers: five, or four when the commentators need the room below
    const hosts = (q.commentators || []).slice(0, 10);
    const rows = (q.results || []).slice(0, hosts.length ? 4 : TOP);
    const rowH = hosts.length ? 100 : 112;
    const logos = await Promise.all(rows.map((r) => (r.logo ? loadImage(`${API}/logo/${encodeURIComponent(r.key)}.svg`) : null)));
    rows.forEach((r, i) => {
      const top = y + i * rowH;
      if (logos[i]) ctx.drawImage(logos[i], 80, top, 76, 76);
      else { ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.beginPath(); ctx.arc(118, top + 38, 38, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = "#fff";
      ctx.font = F(800, 42);
      ctx.fillText(r.label, 180, top + 34);
      ctx.fillStyle = "rgba(255,255,255,.22)";
      ctx.fillRect(180, top + 52, 690, 16);
      ctx.fillStyle = "#fff";
      ctx.fillRect(180, top + 52, Math.max(8, (690 * r.pct) / 100), 16);
      ctx.font = F(900, 50);
      ctx.fillText(`${r.pct}%`, 900, top + 64);
    });
    y += rows.length * rowH + 24;
    if (hosts.length) {
      ctx.fillStyle = "#fff";
      ctx.font = F(900, 34);
      ctx.fillText("🎙 КОММЕНТАТОРЫ HOH", 80, y);
      ctx.font = F(700, 30);
      hosts.forEach((c, i) => {
        const col = i % 2, line = Math.floor(i / 2);
        ctx.fillText(`${surname(c.name)} — ${c.label}`, 80 + col * 470, y + 50 + line * 44);
      });
    }
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.font = F(800, 30);
    ctx.fillText("Отвечайте в приложении Home of Hockey", 80, Hh - 48);
    try { return canvas.toDataURL("image/png"); } catch (e) { return null; }
  }
  async function showPicture() {
    st.note = "";
    const url = await picture();
    if (!url) { st.note = "Не получилось нарисовать картинку"; paint(true); return; }
    const old = document.querySelector(".v37Shade");
    if (old) old.remove();
    const shade = document.createElement("div");
    shade.className = "v37Shade";
    shade.innerHTML = `<div class="v37Pic" role="dialog" aria-label="Картинка вопроса недели"><img src="${url}" alt="Итоги вопроса недели"><p>На телефоне: нажмите на картинку и удерживайте, чтобы сохранить.</p><div class="v37Acts"><a class="v37Act" href="${url}" download="vopros-nedeli.png">Скачать</a><button type="button" class="v37Act" data-v37-close>Закрыть</button></div></div>`;
    document.body.appendChild(shade);
  }

  // ---- loading, answering and painting ------------------------------------------------------------------------------------------
  async function load() {
    if (st.busy) return;
    st.busy = true;
    try {
      const d = await H.api(`${API}/week`);
      if (d && d.ok !== false) st.d = d;
    } catch (e) {
      st.d = st.d || { question: null };
    } finally {
      st.at = Date.now();
      st.busy = false;
      paint(true);
    }
  }
  async function answer(key) {
    const q = st.d && st.d.question;
    if (!q || st.sending) return;
    if (!signedIn()) { st.note = "login"; paint(true); return; }
    st.sending = true;
    st.note = "";
    try {
      const d = await H.api(`${API}/week`, { method: "POST", body: JSON.stringify({ question_id: q.id, answer: key }) });
      if (d && d.ok !== false) st.d = d;
      st.pick = false;
      st.change = false;
    } catch (error) {
      const closed = /closed/.test(String(error && error.message));
      st.note = closed ? "Ответы на этот вопрос уже закрыты" : "Не получилось — попробуйте ещё раз";
      if (closed) { st.at = 0; load(); }
    } finally {
      st.sending = false;
      paint(true);
    }
  }
  function anchor() {
    if (inside()) return null;
    if (tab() === "games") {
      const hero = document.querySelector('#view .v27Sec[data-sec="hero"]');
      return hero ? { el: hero, order: hero.style.order } : null;
    }
    if (["follows", "mine"].includes(tab())) {
      const el = document.getElementById("v35Hosts") || document.getElementById("v33Ach") || document.getElementById("v34Box") || document.getElementById("v29Me");
      return el ? { el, order: "" } : null;
    }
    return null;
  }
  function paint(force) {
    const a = anchor();
    const old = document.getElementById("v37Week");
    if (!a) { if (old) old.remove(); return; }
    if (!st.busy && (!st.d || Date.now() - st.at > 60000)) load();
    const html = cardHtml();
    if (!html) { if (old) old.remove(); return; }
    if (old && old.dataset.v37Html === html && old.previousElementSibling === a.el && !force) return;
    const box = document.createElement("div");
    box.innerHTML = html;
    const next = box.firstElementChild;
    next.dataset.v37Html = html;
    if (a.order) next.style.order = a.order;
    if (old) old.remove();
    a.el.after(next);
  }
  V.paint = paint;
  V.state = st;
  V.picture = picture;

  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-v37-answer],[data-v37-open],[data-v37-change],[data-v37-all],[data-v37-picture],[data-v37-close]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (el.dataset.v37Answer) answer(el.dataset.v37Answer);
    else if (el.hasAttribute("data-v37-open")) { st.pick = true; paint(true); }
    else if (el.hasAttribute("data-v37-change")) { st.change = true; st.pick = true; paint(true); }
    else if (el.hasAttribute("data-v37-all")) { st.all = !st.all; paint(true); }
    else if (el.hasAttribute("data-v37-picture")) showPicture();
    else if (el.hasAttribute("data-v37-close")) { const s = document.querySelector(".v37Shade"); if (s) s.remove(); }
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
