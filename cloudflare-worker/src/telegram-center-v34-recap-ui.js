// Live Center v34 on the screen: «Мои итоги» on the «Мои» screen — the month or the season drawn as a story-sized card
// (1080×1920), shared to a Telegram story or saved as a picture.
// This function is serialized (recapApp.toString()) and served as /telegram-app/v34-recap.js: it must be self-contained.
export function recapApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV34) return;
  const R = (window.HOHV34 = {});
  const API = "/api/telegram-center-v34";
  const SHARE_LINK = "https://hoh.109-172-113-187.sslip.io";
  const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const st = { open: null, data: null, busy: false, url: null };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tg = () => (window.Telegram && window.Telegram.WebApp) || null;
  const inTelegram = () => Boolean(tg() && tg().initData);
  const initData = () => (H.initData || (tg() && tg().initData) || "");
  const word = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };

  function css() {
    if (document.getElementById("v34css")) return;
    const style = document.createElement("style");
    style.id = "v34css";
    style.textContent = `
.v34Box{display:grid;gap:10px;margin:0 0 12px;padding:14px 16px;border:1px solid var(--v29-line,#d9dbe6);border-radius:20px;background:linear-gradient(120deg,rgba(122,61,240,.14),rgba(255,90,0,.12))}
html:not(.v15Light) .v34Box{border-color:#30334a;color:#f7f7fb}
.v34Box b{font-size:16px;font-weight:900}
.v34Box small{font-size:12.5px;font-weight:600;opacity:.75}
.v34Btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.v34Btns button{padding:11px 10px;border:0;border-radius:12px;background:#7a3df0;color:#fff;font:inherit;font-size:14px;font-weight:800;cursor:pointer}
.v34Btns button+button{background:#ff5a00}
.v34Shade{position:fixed;inset:0;z-index:92;display:grid;place-items:center;padding:12px;background:rgba(6,4,16,.82)}
.v34Panel{display:grid;gap:10px;width:min(420px,100%);max-height:96vh}
.v34Panel canvas{width:100%;height:auto;max-height:72vh;object-fit:contain;border-radius:18px;box-shadow:0 20px 50px -20px rgba(0,0,0,.7)}
.v34Acts{display:grid;gap:8px}
.v34Acts button{padding:13px;border:0;border-radius:14px;background:#fff;color:#14121f;font:inherit;font-size:15px;font-weight:900;cursor:pointer}
.v34Acts button.main{background:#ff5a00;color:#fff}
.v34Acts button[disabled]{opacity:.55}
.v34Msg{color:#fff;font-size:13px;font-weight:700;text-align:center;min-height:16px}
`;
    document.head.appendChild(style);
  }

  // ---- the card -----------------------------------------------------------------------------------------------------------------
  function wrap(ctx, text, maxWidth) {
    const words = String(text).split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  // the lines of the card in plain words; the same for the picture and for the tests
  function cardLines(d) {
    const r = d.recap || {};
    const out = { title: "Мои итоги", period: d.label || "", big: r.accuracy == null ? "—" : `${r.accuracy}%`, sub: "", rows: [], level: "", better: "" };
    out.sub = r.settled ? `угадано ${r.correct} из ${r.settled}` : r.picks ? "прогнозы ещё не рассчитаны" : "прогнозов пока нет";
    if (r.xp) out.rows.push(["Очки", `+${r.xp} XP`]);
    if (r.best_streak) out.rows.push(["Лучшая серия", `${r.best_streak} подряд`]);
    if (r.exact) out.rows.push(["Точный счёт", `${r.exact} ${word(r.exact, "раз", "раза", "раз")}`]);
    if (r.best_pick) out.rows.push(["Лучший прогноз", `${r.best_pick.name} при кэфе ${Number(r.best_pick.odds).toFixed(2)}`]);
    if (r.favorite) out.rows.push(["Чаще всего выбирали", `${r.favorite.name} — ${r.favorite.picks} ${word(r.favorite.picks, "раз", "раза", "раз")}`]);
    if (d.level) out.level = `Уровень ${d.level.n} · ${d.level.note}`;
    if (Number(d.better_pct) > 0) out.better = `Точнее, чем у ${Math.round(Number(d.better_pct))}% болельщиков`;
    return out;
  }
  R.cardLines = cardLines;

  function draw(canvas, d) {
    const W = 1080, Hh = 1920;
    canvas.width = W;
    canvas.height = Hh;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return false;
    const L = cardLines(d);
    const g = ctx.createLinearGradient(0, 0, W * 0.4, Hh);
    g.addColorStop(0, "#1c0b45");
    g.addColorStop(0.55, "#6d28d9");
    g.addColorStop(1, "#ff5a00");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Hh);
    // soft rings in the corner
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 3;
    for (let r = 220; r < 900; r += 120) { ctx.beginPath(); ctx.arc(W - 60, 260, r, 0, Math.PI * 2); ctx.stroke(); }
    const F = (weight, size) => `${weight} ${size}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = F(800, 40);
    ctx.fillText("HOME OF HOCKEY · NHL", 90, 170);
    ctx.fillStyle = "#fff";
    ctx.font = F(900, 110);
    ctx.fillText(L.title, 90, 320);
    ctx.font = F(800, 56);
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillText(L.period, 90, 410);
    ctx.fillStyle = "#fff";
    ctx.font = F(900, 300);
    ctx.fillText(L.big, 80, 760);
    ctx.font = F(800, 58);
    ctx.fillText(L.sub, 90, 850);
    let y = 1000;
    for (const [k, v] of L.rows) {
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = F(700, 40);
      ctx.fillText(k, 90, y);
      ctx.fillStyle = "#fff";
      ctx.font = F(900, 54);
      for (const line of wrap(ctx, v, W - 180)) { y += 62; ctx.fillText(line, 90, y); }
      y += 54;
    }
    if (L.better) {
      ctx.fillStyle = "rgba(255,255,255,.16)";
      ctx.fillRect(70, Math.min(y, 1640) - 10, W - 140, 110);
      ctx.fillStyle = "#fff";
      ctx.font = F(900, 50);
      ctx.fillText(L.better, 100, Math.min(y, 1640) + 62);
    }
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.font = F(800, 44);
    ctx.fillText(L.level, 90, 1800);
    return true;
  }
  R.draw = draw;

  // ---- the panel ---------------------------------------------------------------------------------------------------------------
  function close() {
    const el = document.querySelector(".v34Shade");
    if (el) el.remove();
    st.open = null;
    st.url = null;
  }
  function message(text) {
    const el = document.querySelector(".v34Msg");
    if (el) el.textContent = text;
  }
  async function open(period) {
    if (st.busy) return;
    st.busy = true;
    st.url = null;
    try {
      const d = await H.api(`${API}/recap?period=${encodeURIComponent(period)}`);
      if (!d || d.ok === false) throw new Error((d && d.error) || "recap_failed");
      st.data = d;
      st.open = period;
      const shade = document.createElement("div");
      shade.className = "v34Shade";
      const canShare = Boolean(tg() && typeof tg().shareToStory === "function");
      const has = Boolean(d.recap && d.recap.picks);
      shade.innerHTML = `<div class="v34Panel" role="dialog" aria-label="Мои итоги"><canvas class="v34Canvas" width="1080" height="1920" aria-label="${esc(cardLines(d).title)} — ${esc(d.label)}"></canvas><div class="v34Msg"></div><div class="v34Acts">${canShare ? `<button type="button" class="main" data-v34-share${has ? "" : " disabled"}>Поделиться в сторис</button>` : ""}<button type="button" data-v34-save${has ? "" : " disabled"}>Сохранить картинку</button><button type="button" data-v34-close>Закрыть</button></div></div>`;
      document.body.appendChild(shade);
      draw(shade.querySelector("canvas"), d);
      if (!has) message("Сделайте первые прогнозы — и здесь появятся ваши итоги");
    } catch (error) {
      alert("Не удалось загрузить итоги. Попробуйте ещё раз.");
    } finally {
      st.busy = false;
    }
  }
  R.open = open;

  async function upload() {
    if (st.url) return st.url;
    const canvas = document.querySelector(".v34Shade canvas");
    if (!canvas || !canvas.toBlob) throw new Error("no_canvas");
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no_picture");
    const res = await fetch(`${API}/cards?period=${encodeURIComponent(st.open || "month")}`, { method: "POST", headers: { "Content-Type": blob.type || "image/png", "X-Telegram-Init-Data": initData() }, body: blob });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.url) throw new Error(d.error || `upload_${res.status}`);
    st.url = d.url;
    return d.url;
  }
  async function share() {
    message("Готовим картинку…");
    try {
      const url = await upload();
      tg().shareToStory(url, { text: "Мои итоги в HOH NHL Center 🏒", widget_link: { url: SHARE_LINK, name: "HOH NHL" } });
      message("");
    } catch (error) {
      message("Не получилось — попробуйте ещё раз");
    }
  }
  async function save() {
    message("Готовим картинку…");
    try {
      const url = await upload();
      const name = `hoh-itogi-${st.open || "month"}.png`;
      if (tg() && typeof tg().downloadFile === "function") tg().downloadFile({ url, file_name: name });
      else {
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      message("Картинка сохраняется");
    } catch (error) {
      message("Не получилось — попробуйте ещё раз");
    }
  }

  // ---- the block on «Мои» --------------------------------------------------------------------------------------------------------
  function boxHtml() {
    const month = MONTHS[new Date().getMonth()];
    return `<section class="v34Box" id="v34Box"><b>Мои итоги</b> <small>Ваш месяц и сезон одной картинкой — для сторис и друзей</small><div class="v34Btns"><button type="button" data-v34-open="month">${esc(month)}</button><button type="button" data-v34-open="season">Сезон</button></div></section>`;
  }
  function paint() {
    const me = document.getElementById("v29Me");
    const el = document.getElementById("v34Box");
    const onMine = H.currentTab && ["follows", "mine"].includes(H.currentTab()) && !(H.state && H.state.profile);
    if (!me || !onMine || !inTelegram()) { if (el) el.remove(); return; }
    if (el) return;
    const box = document.createElement("div");
    box.innerHTML = boxHtml();
    const ach = document.getElementById("v33Ach");
    if (ach && ach.parentNode === me.parentNode) ach.before(box.firstElementChild);
    else me.after(box.firstElementChild);
  }
  R.paint = paint;

  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-v34-open],[data-v34-share],[data-v34-save],[data-v34-close]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const d = el.dataset;
    if (d.v34Open) open(d.v34Open);
    else if (d.v34Share !== undefined) share();
    else if (d.v34Save !== undefined) save();
    else if (d.v34Close !== undefined) close();
  }, true);

  css();
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; paint(); }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  }
  paint();
}
