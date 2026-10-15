// Live Center v32 on the screen: while a game is on —
//   - the match screen gets «Что я пропустил» (the period, the shots, the penalties, the goals so far) and «На что поставить
//     сейчас» (the live Winline line with a hook from the form of the teams);
//   - the match of the day goes first on the home page with «Сейчас в эфире», and gets the live line too.
// This function is serialized (liveApp.toString()) and served as /telegram-app/v32-live.js: it must be self-contained.
export function liveApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV32) return;
  const V = (window.HOHV32 = {});
  const API = "/api/telegram-center-v32/games/";
  const POLL_MS = 20000;
  const data = new Map(); // game -> { at, payload }
  const busy = new Set();
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const noSpoilers = () => typeof window.HOHNoSpoilers === "function" && Boolean(window.HOHNoSpoilers());

  function css() {
    if (document.getElementById("v32css")) return;
    const style = document.createElement("style");
    style.id = "v32css";
    style.textContent = `
.v32Card,.v32Bet{display:grid;gap:10px;margin:10px 0;padding:13px 14px;border:1px solid var(--v26-line,#2e3142);border-radius:16px;background:var(--v26-card,rgba(16,18,26,.85));color:var(--v26-text,#f4f4f8)}
html.v15Light .v32Card,html.v15Light .v32Bet{border-color:#e3dcf3;background:rgba(255,255,255,.92);color:#14121f}
.v32Top{display:flex;align-items:center;gap:8px}
.v32Top b{font-size:15px;font-weight:900}
.v32Top small{margin-left:auto;font-size:12px;font-weight:800;color:#ff4d5e}
.v32Dot{width:8px;height:8px;border-radius:50%;background:#ff2d46;animation:v32Pulse 1.3s ease-in-out infinite}
@keyframes v32Pulse{50%{opacity:.35}}
.v32Stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.v32Stats div{display:grid;gap:1px;justify-items:center;padding:7px 4px;border-radius:12px;background:rgba(122,61,240,.1)}
.v32Stats b{font-size:16px;font-weight:900}
.v32Stats span{font-size:10.5px;font-weight:700;opacity:.7;text-align:center}
.v32Goals{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.v32Goals li{display:grid;grid-template-columns:62px minmax(0,1fr) auto auto;gap:8px;align-items:center;font-size:13px}
.v32Goals li span{font-size:11.5px;font-weight:700;opacity:.65}
.v32Goals li b{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v32Goals li i{font-style:normal;font-size:11px;font-weight:800;opacity:.75}
.v32Goals li em{font-style:normal;font-weight:900}
.v32None{font-size:13px;opacity:.7}
.v32Bet{border-color:rgba(255,90,0,.45);background:linear-gradient(160deg,rgba(255,90,0,.12),rgba(16,18,26,.85) 60%)}
html.v15Light .v32Bet{border-color:#f3b388;background:linear-gradient(160deg,#fff1e6,#fff 60%)}
.v32BTop{display:flex;align-items:center;gap:8px}
.v32BTop img{height:18px;width:auto}
.v32BTop b{font-size:15px;font-weight:900}
.v32Hook{padding:8px 10px;border-radius:12px;background:linear-gradient(120deg,#6d28d9,#a855f7);color:#fff;font-size:14px;font-weight:800}
.v32Chips{display:flex;flex-wrap:wrap;gap:6px}
.v32Chip{display:inline-flex;align-items:baseline;gap:6px;padding:8px 11px;border-radius:11px;background:#ff5a00;color:#fff!important;text-decoration:none;font-size:13px;font-weight:700}
.v32Chip b{font-size:16px;font-weight:900}
.v32Note{font-size:11px;opacity:.6;font-weight:600}
.v32HeroBet{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.v32HeroBet img{height:15px;width:auto}
.v32HeroBet .v32Chip{padding:6px 9px;font-size:12px}
.v32HeroBet .v32Chip b{font-size:14px}
.v32Live .v26Wl{display:none!important}
.v27Home.v32LiveFirst>[data-sec="hero"]{order:-1!important}
.v27Home.v32LiveFirst>[data-sec="hero"]::before{content:"Сейчас в эфире";display:block;margin:0 0 8px;font-size:18px;font-weight:900;color:var(--c-text,inherit)}
`;
    document.head.appendChild(style);
  }

  const href = (pk) => `/go/winline?game_pk=${encodeURIComponent(pk)}`;
  const chip = (pk, o) => `<a class="v32Chip" href="${href(pk)}" target="_blank" rel="noopener">${esc(o.label)} <b>${Number(o.odds).toFixed(2)}</b></a>`;
  const pair = (o) => `${o.away == null ? "—" : o.away}–${o.home == null ? "—" : o.home}`;

  function recapHtml(p) {
    const r = p.recap;
    if (!r) return "";
    const goals = r.goals.length
      ? `<ol class="v32Goals">${r.goals.map((g) => `<li><span>${esc(g.period)}${g.time ? ` ${esc(g.time)}` : ""}</span> <b>${esc(g.scorer || "Гол")}${g.power_play ? " (бол.)" : ""}</b> <i>${esc(g.team || "")}</i> <em>${esc(g.score_after.away)}:${esc(g.score_after.home)}</em></li>`).join("")}</ol>`
      : '<div class="v32None">Голов пока нет</div>';
    const pens = { away: r.penalties.away.count, home: r.penalties.home.count };
    return `<section class="v32Card" data-v32-recap="${esc(p.game_pk)}"><div class="v32Top"><span class="v32Dot"></span><b>Что я пропустил</b> <small>${esc(p.label || "")}</small></div><div class="v32Stats"><div><b>${esc(pair(r.shots))}</b> <span>броски в створ</span></div><div><b>${esc(pair(pens))}</b> <span>удаления</span></div><div><b>${esc(pair(r.power_play_goals))}</b> <span>голы в большинстве</span></div></div>${goals}</section>`;
  }

  function betHtml(p) {
    if (!p.offers || !p.offers.length) return "";
    const hook = p.hook ? `<div class="v32Hook">🔥 ${esc(p.hook)}</div>` : "";
    return `<section class="v32Bet" data-v32-bet="${esc(p.game_pk)}"><div class="v32BTop"><img src="/broadcast/winline-logo.png?asset=canonical-3" alt="WINLINE"><b>На что поставить сейчас</b></div>${hook}<div class="v32Chips">${p.offers.map((o) => chip(p.game_pk, o)).join("")}</div><div class="v32Note">Коэффициенты live, обновляются каждые 20 секунд</div></section>`;
  }

  // the match of the day: two or three of the live prices under the vote (the next goal and the total first)
  function heroBetHtml(p) {
    if (!p.offers || !p.offers.length) return "";
    const pick = [...p.offers.filter((o) => o.kind === "next_goal"), ...p.offers.filter((o) => o.kind === "total")].slice(0, 3);
    const list = pick.length ? pick : p.offers.slice(0, 2);
    return `<div class="v32HeroBet" data-v32-hero-bet="${esc(p.game_pk)}"><img src="/broadcast/winline-logo.png?asset=canonical-3" alt="WINLINE">${list.map((o) => chip(p.game_pk, o)).join("")}</div>`;
  }

  async function load(pk) {
    if (!pk || busy.has(pk)) return;
    const have = data.get(pk);
    if (have && Date.now() - have.at < POLL_MS - 500) return;
    busy.add(pk);
    try {
      const d = await H.api(`${API}${encodeURIComponent(pk)}/live`);
      data.set(pk, { at: Date.now(), payload: d && d.ok !== false ? d : null });
    } catch (e) {
      data.set(pk, { at: Date.now(), payload: have ? have.payload : null });
    } finally {
      busy.delete(pk);
    }
    paint();
  }

  // draws a block once and redraws it only when its html changed
  function put(existing, html, insert) {
    if (!html) {
      if (existing) existing.remove();
      return null;
    }
    if (existing && existing.dataset.v32Html === html) return existing;
    const box = document.createElement("div");
    box.innerHTML = html;
    const next = box.firstElementChild;
    next.dataset.v32Html = html;
    if (existing) existing.replaceWith(next);
    else insert(next);
    return next;
  }

  function paintMatch() {
    const root = document.getElementById("v26Root");
    const pk = Number(window.HOHV26 && window.HOHV26.state && window.HOHV26.state.gamePk);
    const recapEl = document.querySelector("[data-v32-recap]");
    const betEl = document.querySelector("[data-v32-bet]");
    if (!root || !pk) {
      if (root) root.classList.remove("v32Live");
      if (recapEl) recapEl.remove();
      if (betEl) betEl.remove();
      return;
    }
    const got = data.get(pk);
    if (!got) { load(pk); return; }
    const p = got.payload;
    const on = Boolean(p && p.live && Number(p.game_pk) === pk && !noSpoilers());
    const head = document.getElementById("v26Head") || root.firstElementChild;
    const recap = put(recapEl && root.contains(recapEl) ? recapEl : null, on ? recapHtml(p) : "", (el) => (head ? head.after(el) : root.prepend(el)));
    const bet = put(betEl && root.contains(betEl) ? betEl : null, on ? betHtml(p) : "", (el) => (recap ? recap.after(el) : head ? head.after(el) : root.prepend(el)));
    // the live prices replace the line before the start (it would only confuse during the game)
    root.classList.toggle("v32Live", Boolean(bet));
    if (Date.now() - got.at > POLL_MS && p && p.live) load(pk);
  }

  function paintHome() {
    const home = document.querySelector("#view .v27Home");
    if (!home) return;
    const hero = home.querySelector(".v27Hero[data-game]");
    const live = Boolean(hero && hero.querySelector(".v27LiveBadge"));
    home.classList.toggle("v32LiveFirst", live);
    if (!hero) return;
    const el = hero.querySelector("[data-v32-hero-bet]");
    if (!live) { if (el) el.remove(); return; }
    const pk = Number(hero.dataset.game);
    const got = data.get(pk);
    if (!got) { load(pk); return; }
    const p = got.payload;
    const body = hero.querySelector(".v27HeroBody") || hero;
    const after = body.querySelector(".v29Slot") || body.querySelector(".v27HeroTeams");
    put(el, p && p.live && !noSpoilers() ? heroBetHtml(p) : "", (node) => (after ? after.after(node) : body.appendChild(node)));
    if (Date.now() - got.at > POLL_MS && p && p.live) load(pk);
  }

  function paint() {
    paintMatch();
    paintHome();
  }
  V.paint = paint;
  V.recapHtml = recapHtml;
  V.betHtml = betHtml;
  V.data = data;

  css();
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; paint(); }, 80);
    }).observe(document.body, { childList: true, subtree: true });
  }
  setInterval(() => { if (document.visibilityState !== "hidden") paint(); }, POLL_MS);
  window.addEventListener("hoh-spoilers-change", paint);
  paint();
}
