// Live Center match screen: LIVE badge, goals with scorers and assists, clips that play inside the app.
//
// This function is serialized (goalsScreenApp.toString()) and served as /telegram-app/v26-goals.js, so it must be
// self-contained: no imports and no references to anything outside of its own body.
// The old v19 openGame() hands over to H.openGameV26 and falls back to the legacy page if this one throws.
export function goalsScreenApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV26) return;
  const S = (window.HOHV26 = { version: "26.0" });
  const API = "/api/telegram-center-v26";
  const V19 = "/api/telegram-center-v19";
  const POLL_LIVE_MS = 15000;
  const POLL_FINAL_MS = 30000;
  const POLL_FINAL_LIMIT_MS = 40 * 60 * 1000;
  const FRESH_MS = 90000;

  const esc = (v) =>
    H.esc
      ? H.esc(v)
      : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mb = (bytes) => (bytes ? Math.max(1, Math.round(bytes / 1e6)) + " МБ" : "");
  const full = (p) => (p && (p.name_ru || p.name_en)) || "Игрок";
  const surname = (p) => {
    const name = full(p).trim();
    const parts = name.split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : name;
  };
  const noSpoilers = () => typeof window.HOHNoSpoilers === "function" && window.HOHNoSpoilers() === true;
  const phaseOfCode = (code) => {
    const c = String(code || "").toUpperCase();
    if (c === "LIVE" || c === "CRIT") return "live";
    if (c === "FINAL" || c === "OFF") return "final";
    if (c === "PPD" || c === "SUSP" || c === "CAN") return "postponed";
    return "upcoming";
  };

  const state = {};
  S.state = state;
  function resetState(gamePk, ctx) {
    stopPolling();
    Object.assign(state, {
      gamePk, ctx: ctx || {}, game: null, extra: null, payload: null, tab: "goals",
      openEvent: null, special: null, revealed: false, fresh: new Map(), seen: null, openedAt: Date.now(), timer: null, busy: false,
      // every goal opens in the light version (about 10 MB); the original is one tap away and applies to this screen only
      quality: "light",
    });
  }
  const phase = () => (state.payload && state.payload.state && state.payload.state.phase) || phaseOfCode(state.game && state.game.game_state);

  function css() {
    if (document.getElementById("v26css")) return;
    const style = document.createElement("style");
    style.id = "v26css";
    style.textContent = `
.v26Match{--v26-card:#10121a;--v26-card2:#171a24;--v26-line:#282b38;--v26-text:#f7f7fb;--v26-muted:#9094a8;--v26-accent:#ff5a00;--v26-lav:#b58aff;--v26-live:#ff4d5e;--v26-liveBg:rgba(255,77,94,.15);display:grid;gap:10px;font-variant-numeric:tabular-nums}
html.v15Light .v26Match{--v26-card:#ffffff;--v26-card2:#f1f2f7;--v26-line:#e2e4ec;--v26-text:#0c0d14;--v26-muted:#686c7e;--v26-lav:#7a3df0;--v26-live:#e5243b;--v26-liveBg:rgba(229,36,59,.1)}
.v26Head{background:var(--v26-card);border:1px solid var(--v26-line);border-radius:16px;padding:14px 12px 12px;display:grid;gap:12px}
.v26Pills{display:flex;justify-content:center}
.v26Pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;background:var(--v26-card2);color:var(--v26-muted)}
.v26Pill.live{background:var(--v26-liveBg);color:var(--v26-live)}
.v26Pill.live i{width:7px;height:7px;border-radius:50%;background:var(--v26-live);animation:v26Pulse 1.4s ease-in-out infinite}
@keyframes v26Pulse{50%{opacity:.3}}
.v26Teams{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;text-align:center}
.v26Team{border:0;background:none;color:inherit;font:inherit;display:grid;gap:5px;justify-items:center;cursor:pointer;padding:0;min-width:0}
.v26Team img{width:48px;height:48px;object-fit:contain}
.v26Team b{font-size:15px;font-weight:800;color:var(--v26-text)}
.v26Team span{font-size:12px;color:var(--v26-muted);font-weight:600;line-height:1.25}
.v26Score{font-size:34px;font-weight:800;color:var(--v26-text);letter-spacing:1px;white-space:nowrap}
.v26Shots{display:flex;justify-content:center;gap:16px;font-size:12px;color:var(--v26-muted);font-weight:600}
.v26Tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.v26Tab{border:1px solid var(--v26-line);background:transparent;color:var(--v26-muted);border-radius:10px;padding:9px 0;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.v26Tab.on{background:var(--v26-text);color:var(--v26-card);border-color:var(--v26-text)}
.v26List{display:grid;gap:8px}
.v26Goal{background:var(--v26-card);border:1px solid var(--v26-line);border-radius:14px;padding:11px 12px;display:grid;gap:10px}
.v26Goal.fresh{border-color:var(--v26-live)}
.v26Row{display:grid;grid-template-columns:46px minmax(0,1fr) auto;gap:10px;align-items:center}
.v26When{text-align:center}
.v26When small{display:block;font-size:11px;color:var(--v26-muted);font-weight:600}
.v26When b{font-size:14px;font-weight:800;color:var(--v26-text)}
.v26Who{min-width:0;display:grid;gap:3px}
.v26WhoTop{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.v26Tri{font-size:11px;font-weight:800;padding:1px 7px;border-radius:7px;border:1px solid var(--v26-line);color:var(--v26-text);background:var(--v26-card2)}
.v26Link{border:0;background:none;padding:0;font:inherit;font-size:15px;font-weight:800;color:var(--v26-text);display:inline-flex;align-items:center;gap:2px;text-align:left;cursor:pointer}
.v26Link i{font-style:normal;color:var(--v26-muted);font-size:16px}
.v26Tag{font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:var(--v26-card2);color:var(--v26-muted)}
.v26Tag.hot{background:var(--v26-liveBg);color:var(--v26-live)}
.v26Assist{font-size:12px;color:var(--v26-muted);font-weight:500;line-height:1.4}
.v26Assist button{border:0;background:none;padding:0;font:inherit;color:var(--v26-text);font-weight:700;cursor:pointer}
.v26Wait{font-size:12px;color:var(--v26-lav);font-weight:600}
.v26Right{display:grid;gap:7px;justify-items:center}
.v26GoalScore{font-size:16px;font-weight:800;color:var(--v26-text)}
.v26Play{width:42px;height:42px;border-radius:50%;border:0;background:var(--v26-text);color:var(--v26-card);display:grid;place-items:center;cursor:pointer;padding:0}
.v26Play svg{width:18px;height:18px;fill:currentColor;margin-left:2px}
.v26Play.on{background:var(--v26-accent);color:#fff}
.v26Spin{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:var(--v26-card2)}
.v26Spin::after{content:"";width:16px;height:16px;border-radius:50%;border:2px solid var(--v26-lav);border-right-color:transparent;animation:v26Rot .9s linear infinite}
@keyframes v26Rot{to{transform:rotate(360deg)}}
.v26Player{display:grid;gap:8px}
.v26Player video{width:100%;aspect-ratio:16/9;border-radius:10px;background:#000;display:block}
.v26Bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--v26-muted);font-weight:600}
.v26Q{display:inline-flex;gap:6px}
.v26Q button{border:1px solid var(--v26-line);background:transparent;color:var(--v26-muted);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.v26Q button.on{border-color:var(--v26-text);color:var(--v26-text)}
.v26Err{font-size:12px;color:var(--v26-live);font-weight:600}
.v26Big{width:100%;border:1px solid var(--v26-line);background:var(--v26-card);color:var(--v26-text);border-radius:12px;padding:12px;font:inherit;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
.v26Big svg{width:16px;height:16px;fill:currentColor}
.v26Note{background:var(--v26-card);border:1px dashed var(--v26-line);border-radius:12px;padding:14px;font-size:13px;color:var(--v26-muted);font-weight:500;text-align:center;line-height:1.45}
.v26Note .v26Big{margin-top:10px}
.v26Info{display:grid;gap:8px}
.v26Odds{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.v26Odd{text-decoration:none;color:var(--v26-text);background:var(--v26-card);border:1px solid var(--v26-line);border-radius:12px;padding:9px 6px;text-align:center;display:grid;gap:2px}
.v26Odd small{font-size:11px;color:var(--v26-muted);font-weight:700}
.v26Odd b{font-size:17px;font-weight:800}
.v26Meta{background:var(--v26-card);border:1px solid var(--v26-line);border-radius:12px;padding:10px 12px;display:grid;gap:3px}
.v26Meta small{font-size:11px;color:var(--v26-muted);font-weight:700}
.v26Meta span{font-size:14px;font-weight:700;color:var(--v26-text)}
.v26Vk{display:block;text-align:center;text-decoration:none;background:var(--v26-accent);color:#fff;border-radius:12px;padding:12px;font-size:14px;font-weight:800}
.v26PgBtn{display:flex!important;align-items:center;justify-content:center;gap:8px}
.v26PgBtn svg{width:15px;height:15px;fill:currentColor}
.v26PgHero{background:var(--v26-card);border:1px solid var(--v26-line);border-radius:16px;padding:14px 12px;display:grid;gap:4px}
.v26PgHero b{font-size:18px;font-weight:800;color:var(--v26-text)}
.v26PgHero span{font-size:13px;color:var(--v26-muted);font-weight:600}
.v26GameHead{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:0;background:none;color:var(--v26-text);font:inherit;padding:8px 2px 0;cursor:pointer;text-align:left}
.v26GameHead span{font-size:12px;color:var(--v26-muted);font-weight:700}
.v26GameHead b{font-size:14px;font-weight:800;flex:1}
.v26GameHead i{font-style:normal;font-size:12px;color:var(--v26-lav);font-weight:700}
`;
    document.head.appendChild(style);
  }

  const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  }

  function scoreText() {
    const p = state.payload;
    const g = state.game;
    const ph = phase();
    if (ph === "upcoming" || ph === "postponed") return "—";
    if (noSpoilers() && !state.revealed) return "• : •";
    const away = p && p.teams && p.teams.away.score != null ? p.teams.away.score : g.away_score;
    const home = p && p.teams && p.teams.home.score != null ? p.teams.home.score : g.home_score;
    return `${away == null ? 0 : away} : ${home == null ? 0 : home}`;
  }

  function headHtml() {
    const g = state.game;
    const p = state.payload;
    const ph = phase();
    let pill;
    if (ph === "live") pill = `<span class="v26Pill live"><i></i>LIVE${p && p.state.label_ru ? " · " + esc(p.state.label_ru) : ""}</span>`;
    else if (ph === "final") pill = `<span class="v26Pill">${esc((p && p.state.label_ru) || "Финал")}</span>`;
    else if (ph === "postponed") pill = '<span class="v26Pill">Матч перенесён</span>';
    else pill = `<span class="v26Pill">${esc(when(g.scheduled_start_utc))}</span>`;
    const team = (t) =>
      `<button class="v26Team" data-v26-team="${esc(t.tri)}" aria-label="${esc(t.name_ru || t.tri)}"><img src="${esc(t.logo || "")}" alt=""><b>${esc(t.tri)}</b><span>${esc(t.name_ru || t.name_en || "")}</span></button>`;
    const shots =
      p && p.teams.away.shots != null && p.teams.home.shots != null && ph !== "upcoming" && !(noSpoilers() && !state.revealed)
        ? `<div class="v26Shots"><span>Броски ${esc(p.teams.away.shots)} : ${esc(p.teams.home.shots)}</span></div>`
        : "";
    return `<div class="v26Head"><div class="v26Pills">${pill}</div><div class="v26Teams">${team(g.away)}<div class="v26Score">${esc(scoreText())}</div>${team(g.home)}</div>${shots}</div>`;
  }

  function tabsHtml() {
    const tab = (id, label) => `<button class="v26Tab${state.tab === id ? " on" : ""}" data-v26-tab="${id}">${label}</button>`;
    return tab("goals", "Голы") + tab("about", "О матче");
  }

  function assistsHtml(goal) {
    if (!goal.assists || !goal.assists.length) return '<div class="v26Assist">Без передач</div>';
    const links = goal.assists
      .map((a) => (a.id ? `<button data-v26-player="${esc(a.id)}">${esc(surname(a))}</button>` : esc(surname(a))))
      .join(", ");
    return `<div class="v26Assist">Передачи: ${links}</div>`;
  }

  function goalHtml(goal) {
    const clip = goal.clip || { state: "none" };
    const open = state.openEvent === goal.event_id && !state.special;
    const fresh = state.fresh.get(goal.event_id) > Date.now();
    let action = "";
    let waitNote = "";
    if (clip.state === "ready") {
      action = `<button class="v26Play${open ? " on" : ""}" data-play="${esc(goal.event_id)}" aria-label="${open ? "Закрыть видео" : "Смотреть гол"}">${PLAY_SVG}</button>`;
    } else if (clip.state === "pending") {
      action = '<div class="v26Spin" aria-label="Видео готовится"></div>';
      waitNote = '<div class="v26Wait">Видео будет через 3–4 минуты</div>';
    }
    const tags = [];
    if (fresh) tags.push('<span class="v26Tag hot">новый гол</span>');
    if (goal.strength_label_ru) tags.push(`<span class="v26Tag">${esc(goal.strength_label_ru)}</span>`);
    if (goal.modifier_label_ru) tags.push(`<span class="v26Tag">${esc(goal.modifier_label_ru)}</span>`);
    const scorer = goal.scorer || {};
    const scorerHtml = scorer.id
      ? `<button class="v26Link" data-v26-player="${esc(scorer.id)}">${esc(full(scorer))}<i>›</i></button>`
      : `<b>${esc(full(scorer))}</b>`;
    const sa = goal.score_after || {};
    return `<div class="v26Goal${fresh ? " fresh" : ""}" data-goal="${esc(goal.event_id)}"><div class="v26Row"><div class="v26When"><small>${esc(goal.period.short_ru)}</small><b>${esc(goal.time || "")}</b></div><div class="v26Who"><div class="v26WhoTop"><span class="v26Tri">${esc(goal.team || "")}</span>${scorerHtml}${tags.join("")}</div>${assistsHtml(goal)}${waitNote}</div><div class="v26Right"><div class="v26GoalScore">${esc(sa.away)}:${esc(sa.home)}</div>${action}</div></div><div data-slot="${esc(goal.event_id)}"></div></div>`;
  }

  function specialButtons() {
    const c = state.payload && state.payload.clips;
    if (!c) return "";
    let out = "";
    if (c.all_goals) out += `<button class="v26Big" data-special="all_goals">${PLAY_SVG}Все голы матча одним роликом</button>`;
    if (c.ending) out += `<button class="v26Big" data-special="ending">${PLAY_SVG}Концовка матча</button>`;
    return out;
  }

  function goalsBodyHtml() {
    const ph = phase();
    const p = state.payload;
    if (!p) return '<div class="v26Note">Голы временно недоступны.<button class="v26Big" data-retry="1">Обновить</button></div>';
    if (ph === "upcoming") return '<div class="v26Note">Матч ещё не начался. Голы появятся здесь сразу после первой шайбы.</div>';
    if (ph === "postponed") return '<div class="v26Note">Матч перенесён.</div>';
    if (noSpoilers() && !state.revealed) {
      return '<div class="v26Note">Включён режим «без спойлеров». Счёт и голы скрыты.<button class="v26Big" data-reveal="1">Показать голы</button></div>';
    }
    if (!p.goals.length) return `<div class="v26Note">${ph === "live" ? "Пока без голов." : "В этом матче не было голов."}</div>`;
    let notes = "";
    if (!p.clips.server_ok) notes = '<div class="v26Note">Видео временно недоступно, голы показаны без роликов.</div>';
    else if (ph === "final" && !p.clips.available && p.clips.ready === 0 && !p.goals.some((g) => g.clip.state === "pending")) {
      notes = '<div class="v26Note">Видео этого матча нет.</div>';
    }
    return `<div class="v26List">${notes}<div id="v26Special"></div>${p.goals.map(goalHtml).join("")}${specialButtons()}</div>`;
  }

  function aboutBodyHtml() {
    const g = state.game;
    const x = state.extra || {};
    const markets = (x.winline && x.winline.markets) || [];
    const find = (key) => markets.find((m) => m.outcome_key === key && Number(m.odds) > 1);
    const home = find("home");
    const draw = find("draw");
    const away = find("away");
    const href = `/go/winline?game_pk=${encodeURIComponent(state.gamePk)}`;
    const chip = (label, m) => (m ? `<a class="v26Odd" href="${href}" target="_blank" rel="noopener"><small>${esc(label)}</small><b>${Number(m.odds).toFixed(2)}</b></a>` : "");
    const odds = home || draw || away ? `<div class="v26Odds">${chip(g.home.tri, home)}${chip("Ничья", draw)}${chip(g.away.tri, away)}</div>` : "";
    const vk = x.broadcast && (x.broadcast.web_url || x.broadcast.app_url);
    return `<div class="v26Info">${odds}<div class="v26Meta"><small>Дата и время</small><span>${esc(when(g.scheduled_start_utc))}</span></div><div class="v26Meta"><small>Арена</small><span>${esc(g.venue_name || "—")}</span></div>${vk ? `<a class="v26Vk" data-link="${esc(vk)}" href="${esc(vk)}" target="_blank" rel="noopener">Смотреть матч в VK Видео</a>` : ""}</div>`;
  }

  function slotFor(selector) {
    return document.querySelector(selector);
  }
  const goalSlot = () => slotFor(`[data-slot="${String(state.openEvent).replace(/"/g, "")}"]`);

  function readyGoal(eventId) {
    const goal = state.payload && state.payload.goals.find((g) => g.event_id === eventId);
    return goal && goal.clip && goal.clip.state === "ready" ? goal : null;
  }

  function srcOf(clip, quality = state.quality) {
    return quality === "light" && clip.light_url ? clip.light_url : clip.orig_url;
  }

  function playerHtml(clip, label, quality = state.quality, qAttr = "data-q") {
    const hasLight = Boolean(clip.light_url);
    const switcher = hasLight
      ? `<span class="v26Q"><button ${qAttr}="orig" class="${quality === "orig" ? "on" : ""}">Оригинал${clip.orig_bytes ? " · " + mb(clip.orig_bytes) : ""}</button><button ${qAttr}="light" class="${quality === "light" ? "on" : ""}">Лёгкая${clip.light_bytes ? " · " + mb(clip.light_bytes) : ""}</button></span>`
      : "";
    return `<div class="v26Player"><video controls playsinline webkit-playsinline preload="metadata"${clip.poster_url ? ` poster="${esc(clip.poster_url)}"` : ""} src="${esc(srcOf(clip, quality))}"></video><div class="v26Bar"><span>${esc(label)}</span>${switcher}</div><div class="v26Err" hidden></div></div>`;
  }

  function currentClip() {
    if (state.special) {
      const c = state.payload && state.payload.clips && state.payload.clips[state.special];
      return c ? { clip: c, label: state.special === "ending" ? "Концовка матча" : "Все голы матча" } : null;
    }
    const goal = readyGoal(state.openEvent);
    return goal ? { clip: goal.clip, label: "Гол, празднование и повторы" } : null;
  }

  function removePlayer() {
    document.querySelectorAll(".v26Player").forEach((el) => {
      const v = el.querySelector("video");
      if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) { /* ignore */ } }
      el.remove();
    });
  }

  function mountPlayer(autoplay) {
    const cur = currentClip();
    if (!cur) return;
    const slot = state.special ? slotFor("#v26Special") : goalSlot();
    if (!slot) return;
    removePlayer();
    slot.innerHTML = playerHtml(cur.clip, cur.label);
    const video = slot.querySelector("video");
    video.addEventListener("error", () => {
      const err = slot.querySelector(".v26Err");
      if (err) {
        err.hidden = false;
        err.textContent = state.quality === "orig" && cur.clip.light_url ? "Не удалось загрузить оригинал. Попробуйте лёгкую версию." : "Не удалось загрузить видео. Проверьте соединение.";
      }
    });
    if (autoplay) {
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => { /* the user can press play */ });
    }
  }

  function setQuality(q) {
    state.quality = q === "light" ? "light" : "orig";
    const video = document.querySelector(".v26Player video");
    const cur = currentClip();
    document.querySelectorAll(".v26Q button").forEach((b) => b.classList.toggle("on", b.dataset.q === state.quality));
    if (!video || !cur) return;
    const t = video.currentTime;
    const wasPlaying = !video.paused;
    video.src = srcOf(cur.clip);
    video.addEventListener("loadedmetadata", () => {
      try { video.currentTime = t; } catch (e) { /* ignore */ }
      if (wasPlaying) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
    }, { once: true });
    const err = video.parentElement && video.parentElement.querySelector(".v26Err");
    if (err) err.hidden = true;
  }

  function paintHead() {
    const el = document.getElementById("v26Head");
    if (el) el.innerHTML = headHtml();
  }
  function paintTabs() {
    const el = document.getElementById("v26Tabs");
    if (el) el.innerHTML = tabsHtml();
  }
  function paintBody() {
    const body = document.getElementById("v26Body");
    if (!body) return;
    const keep = body.querySelector(".v26Player");
    if (keep) keep.remove();
    body.innerHTML = state.tab === "about" ? aboutBodyHtml() : goalsBodyHtml();
    if (keep && state.tab === "goals") {
      const slot = state.special ? slotFor("#v26Special") : goalSlot();
      if (slot) slot.appendChild(keep);
    } else if (keep) {
      const v = keep.querySelector("video");
      if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
    }
  }

  // Opening a player or team from the match: their "back" button must bring the person back to this match, not to the list.
  function leaveTo(open) {
    stopPolling();
    const gamePk = state.gamePk;
    const ctx = state.ctx;
    H.state.returnTo = () => openMatch(gamePk, ctx).catch((e) => console.warn("v26 return to the match failed", e));
    open();
  }

  function back() {
    stopPolling();
    H.state.returnTo = null;
    const ctx = state.ctx || {};
    if (typeof ctx.returnTo === "function") return ctx.returnTo();
    if (ctx.playerId && H.openPlayer) return H.openPlayer(ctx.playerId);
    if (ctx.teamTri && H.openTeam) return H.openTeam(ctx.teamTri);
    return H.goBack();
  }

  function onClick(event) {
    const target = event.target.closest("[data-v26-team],[data-v26-player],[data-play],[data-special],[data-q],[data-v26-tab],[data-reveal],[data-retry],[data-link]");
    if (!target) return;
    if (target.dataset.link) {
      event.preventDefault();
      const url = target.dataset.link;
      try {
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) window.Telegram.WebApp.openLink(url, { try_instant_view: false });
        else window.location.href = url;
      } catch (e) { window.location.href = url; }
      return;
    }
    if (target.dataset.v26Team) { if (H.openTeam) leaveTo(() => H.openTeam(target.dataset.v26Team)); return; }
    if (target.dataset.v26Player) { if (H.openPlayer) leaveTo(() => H.openPlayer(Number(target.dataset.v26Player))); return; }
    if (target.dataset.v26Tab) { state.tab = target.dataset.v26Tab; paintTabs(); paintBody(); return; }
    if (target.dataset.reveal) { state.revealed = true; paintHead(); paintBody(); return; }
    if (target.dataset.retry) { reloadPayload(true); return; }
    if (target.dataset.q) { setQuality(target.dataset.q); return; }
    if (target.dataset.special) {
      const same = state.special === target.dataset.special;
      removePlayer();
      state.openEvent = null;
      state.special = same ? null : target.dataset.special;
      paintBody();
      if (state.special) {
        mountPlayer(true);
        const el = document.getElementById("v26Special");
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return;
    }
    if (target.dataset.play) {
      const id = Number(target.dataset.play);
      const closing = state.openEvent === id && !state.special;
      removePlayer();
      state.special = null;
      state.openEvent = closing ? null : id;
      paintBody();
      if (!closing) mountPlayer(true);
    }
  }

  function stopPolling() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }
  function pendingLeft() {
    return Boolean(state.payload && state.payload.goals.some((g) => g.clip.state === "pending"));
  }
  function schedule() {
    stopPolling();
    const ph = phase();
    if (ph === "live") state.timer = setInterval(tick, POLL_LIVE_MS);
    else if (ph === "final" && pendingLeft() && Date.now() - state.openedAt < POLL_FINAL_LIMIT_MS) state.timer = setInterval(tick, POLL_FINAL_MS);
  }

  function applyPayload(payload) {
    const ids = new Set(payload.goals.map((g) => g.event_id));
    if (state.seen) {
      for (const id of ids) {
        if (!state.seen.has(id)) {
          state.fresh.set(id, Date.now() + FRESH_MS);
          setTimeout(() => { if (document.getElementById("v26Root")) paintBody(); }, FRESH_MS + 50);
        }
      }
    }
    state.seen = ids;
    state.payload = payload;
  }

  async function reloadPayload() {
    if (state.busy) return;
    state.busy = true;
    try {
      const payload = await H.api(`${API}/games/${state.gamePk}/goals`);
      if (!payload || payload.ok === false) throw new Error((payload && payload.error) || "goals_unavailable");
      applyPayload(payload);
    } catch (e) {
      /* keep what is on screen; the next tick tries again */
    } finally {
      state.busy = false;
    }
    if (!document.getElementById("v26Root")) return;
    paintHead();
    paintBody();
    schedule();
  }

  async function tick() {
    if (!document.getElementById("v26Root")) { stopPolling(); return; }
    if (document.visibilityState === "hidden") return;
    await reloadPayload();
  }

  async function openMatch(gamePk, ctx) {
    gamePk = Number(gamePk);
    if (!gamePk) return;
    css();
    resetState(gamePk, ctx);
    H.state.returnTo = null;
    H.state.profile = true;
    H.state.returnTab = (ctx && ctx.returnTab) || H.currentTab() || "broadcasts";
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.style.display = "none";
    const root = H.view();
    if (!root) return;
    root.innerHTML = '<div class="v15Loading">Загрузка матча…</div>';
    const [gameRes, goalsRes] = await Promise.allSettled([H.api(`${V19}/games/${gamePk}`), H.api(`${API}/games/${gamePk}/goals`)]);
    if (gameRes.status !== "fulfilled" || !gameRes.value || !gameRes.value.game) {
      throw new Error((gameRes.status === "fulfilled" && gameRes.value && gameRes.value.error) || "game_not_found");
    }
    state.game = gameRes.value.game;
    state.extra = gameRes.value;
    if (goalsRes.status === "fulfilled" && goalsRes.value && goalsRes.value.ok !== false) applyPayload(goalsRes.value);
    root.innerHTML = `<div class="v26Match" id="v26Root">${H.backRow("Матч")}<div id="v26Head"></div><div class="v26Tabs" id="v26Tabs"></div><div id="v26Body"></div></div>`;
    const backButton = document.getElementById("v15Back");
    if (backButton) backButton.onclick = back;
    document.getElementById("v26Root").addEventListener("click", onClick);
    paintHead();
    paintTabs();
    paintBody();
    schedule();
  }

  window.addEventListener("hoh-spoilers-change", () => {
    if (document.getElementById("v26Root")) { paintHead(); paintBody(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.getElementById("v26Root") && state.timer) tick();
  });

  // ---- goals of one player: a page reached from the player profile ------------------------------------------------
  const pg = { id: null, payload: null, openKey: null, quality: "light", revealed: false, failed: false };
  S.pg = pg;
  const pgKey = (g) => `${g.game_pk}:${g.event_id}`;
  const pgGoal = (key) => (pg.payload && pg.payload.goals.find((g) => pgKey(g) === key)) || null;

  function dayText(iso, withYear) {
    const d = new Date(`${iso}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ru-RU", withYear ? { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" } : { day: "numeric", month: "long", timeZone: "UTC" });
  }

  function pgGoalHtml(g) {
    const key = pgKey(g);
    const open = pg.openKey === key;
    const sa = g.score_after || {};
    const where = g.team && g.home ? (g.team === g.home ? "дома" : "в гостях") : "";
    const play = `<button class="v26Play${open ? " on" : ""}" data-pg-play="${esc(key)}" aria-label="${open ? "Закрыть видео" : "Смотреть гол"}">${PLAY_SVG}</button>`;
    return `<div class="v26Goal" data-pg-goal="${esc(key)}"><div class="v26Row"><div class="v26When"><small>${esc(g.period.short_ru)}</small><b>${esc(g.time || "")}</b></div><div class="v26Who"><div class="v26WhoTop"><span class="v26Tri">${esc(g.team || "")}</span>${where ? `<span class="v26Tag">${esc(where)}</span>` : ""}</div><div class="v26Assist">Счёт после гола ${esc(sa.away)}:${esc(sa.home)}</div></div><div class="v26Right">${play}</div></div><div data-pg-slot="${esc(key)}"></div></div>`;
  }

  function pgBodyHtml() {
    const p = pg.payload;
    if (!p) return '<div class="v26Note">Голы игрока временно недоступны.<button class="v26Big" data-pg-retry="1">Обновить</button></div>';
    if (!p.server_ok) return '<div class="v26Note">Видео временно недоступно. Попробуйте чуть позже.<button class="v26Big" data-pg-retry="1">Обновить</button></div>';
    if (noSpoilers() && !pg.revealed) {
      return '<div class="v26Note">Включён режим «без спойлеров». Голы игрока скрыты.<button class="v26Big" data-pg-reveal="1">Показать голы</button></div>';
    }
    if (!p.goals.length) {
      return `<div class="v26Note">Роликов с голами этого игрока пока нет.${p.since ? ` Видео в базе с ${esc(dayText(p.since))}.` : ""}</div>`;
    }
    let html = "";
    let lastGame = null;
    for (const g of p.goals) {
      if (g.game_pk !== lastGame) {
        lastGame = g.game_pk;
        html += `<button class="v26GameHead" data-pg-game="${esc(g.game_pk)}"><span>${esc(dayText(g.date))}</span><b>${esc(g.away || "")} — ${esc(g.home || "")}</b><i>Матч ›</i></button>`;
      }
      html += pgGoalHtml(g);
    }
    return `<div class="v26List">${html}</div>`;
  }

  function pgHeroHtml() {
    const p = pg.payload;
    const name = (p && p.player && (p.player.name_ru || p.player.name_en)) || "Игрок";
    let line = "";
    if (p && p.server_ok && !(noSpoilers() && !pg.revealed)) {
      line = p.total ? `Голов с видео: ${p.total} · матчей: ${p.games}` : "Пока без роликов";
      if (p.since) line += ` · видео в базе с ${dayText(p.since)}`;
    }
    return `<div class="v26PgHero"><b>${esc(name)}</b>${line ? `<span>${esc(line)}</span>` : ""}</div>`;
  }

  function pgPaint() {
    const root = document.getElementById("v26PgRoot");
    if (!root) return;
    removePlayer();
    const hero = root.querySelector("#v26PgHero");
    const body = root.querySelector("#v26PgBody");
    if (hero) hero.innerHTML = pgHeroHtml();
    if (body) body.innerHTML = pgBodyHtml();
    if (pg.openKey && pgGoal(pg.openKey)) pgMount(pg.openKey, false);
    else pg.openKey = null;
  }

  function pgMount(key, autoplay) {
    const goal = pgGoal(key);
    const slot = document.querySelector(`[data-pg-slot="${String(key).replace(/"/g, "")}"]`);
    if (!goal || !slot) return;
    removePlayer();
    slot.innerHTML = playerHtml(goal.clip, `${dayText(goal.date)} · ${goal.away || ""} — ${goal.home || ""}`, pg.quality, "data-pg-q");
    const video = slot.querySelector("video");
    video.addEventListener("error", () => {
      const err = slot.querySelector(".v26Err");
      if (err) {
        err.hidden = false;
        err.textContent = pg.quality === "orig" && goal.clip.light_url ? "Не удалось загрузить оригинал. Попробуйте лёгкую версию." : "Не удалось загрузить видео. Проверьте соединение.";
      }
    });
    if (autoplay) {
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => { /* the user can press play */ });
    }
  }

  function pgSetQuality(q) {
    pg.quality = q === "light" ? "light" : "orig";
    const video = document.querySelector(".v26Player video");
    const goal = pgGoal(pg.openKey);
    document.querySelectorAll(".v26Q button").forEach((b) => b.classList.toggle("on", b.dataset.pgQ === pg.quality));
    if (!video || !goal) return;
    const t = video.currentTime;
    const wasPlaying = !video.paused;
    video.src = srcOf(goal.clip, pg.quality);
    const err = document.querySelector(".v26Player .v26Err");
    if (err) err.hidden = true;
    video.addEventListener("loadedmetadata", () => {
      try { video.currentTime = t; } catch (e) { /* ignore */ }
      if (wasPlaying) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
    }, { once: true });
  }

  function pgBack() {
    const v23 = window.HOHV23;
    if (v23 && typeof v23.renderMain === "function" && v23.current) return v23.renderMain(v23.current);
    return H.goBack();
  }

  function pgClick(event) {
    const target = event.target.closest("[data-pg-play],[data-pg-q],[data-pg-game],[data-pg-reveal],[data-pg-retry]");
    if (!target) return;
    if (target.dataset.pgPlay) {
      const key = target.dataset.pgPlay;
      const closing = pg.openKey === key;
      pg.openKey = closing ? null : key;
      document.querySelectorAll(".v26Play.on").forEach((b) => b.classList.remove("on"));
      removePlayer();
      if (!closing) { target.classList.add("on"); pgMount(key, true); }
      return;
    }
    if (target.dataset.pgQ) { pgSetQuality(target.dataset.pgQ); return; }
    if (target.dataset.pgReveal) { pg.revealed = true; pgPaint(); return; }
    if (target.dataset.pgRetry) { openPlayerGoals(pg.id); return; }
    if (target.dataset.pgGame) {
      const id = pg.id;
      H.openGameV26(Number(target.dataset.pgGame), { returnTab: H.currentTab() || "players", returnTo: () => openPlayerGoals(id) });
    }
  }

  async function openPlayerGoals(playerId) {
    playerId = Number(playerId);
    if (!playerId) return;
    css();
    Object.assign(pg, { id: playerId, payload: null, openKey: null, quality: "light", revealed: false });
    H.state.profile = true;
    const root = H.view();
    if (!root) return;
    root.innerHTML = '<div class="v15Loading">Загрузка голов…</div>';
    try {
      const res = await H.api(`${API}/players/${playerId}/goals`);
      if (res && res.ok !== false) pg.payload = res;
    } catch (e) { console.warn("v26 player goals failed", e); }
    root.innerHTML = `<div class="v26Match" id="v26PgRoot">${H.backRow("Голы игрока")}<div id="v26PgHero"></div><div id="v26PgBody"></div></div>`;
    const backButton = document.getElementById("v15Back");
    if (backButton) backButton.onclick = pgBack;
    document.getElementById("v26PgRoot").addEventListener("click", pgClick);
    pgPaint();
  }

  // The player profile belongs to another layer (v23). It keeps its own context in window.HOHV23.current and replaces the whole
  // page on every render, so a light observer on the page container adds the "Голы игрока" button after each render.
  function decoratePlayerPage() {
    const profile = document.querySelector(".v23PlayerProfile");
    if (!profile || profile.querySelector(".v26PgBtn")) return;
    const ctx = window.HOHV23 && window.HOHV23.current;
    const id = ctx && ctx.p && Number(ctx.p.player_id);
    const anchor = profile.querySelector("#v23AllStats");
    if (!id || !anchor) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "v23AllStatsBtn v26PgBtn";
    button.innerHTML = `${PLAY_SVG}Голы игрока · видео`;
    button.addEventListener("click", () => openPlayerGoals(id));
    anchor.insertAdjacentElement("afterend", button);
    css();
  }
  const view = H.view && H.view();
  if (view && typeof MutationObserver === "function") {
    new MutationObserver(decoratePlayerPage).observe(view, { childList: true });
    decoratePlayerPage();
  }
  window.addEventListener("hoh-spoilers-change", () => {
    if (document.getElementById("v26PgRoot")) pgPaint();
  });

  S.tick = tick;
  H.openGameV26 = openMatch;
  H.openPlayerGoalsV26 = openPlayerGoals;
}
