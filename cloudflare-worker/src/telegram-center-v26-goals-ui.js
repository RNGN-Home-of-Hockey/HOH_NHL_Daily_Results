// Live Center match screen: cover of the VK broadcast, Winline line, goals with scorers and assists, clips that play inside the app,
// LIVE updates, and the page with every goal of one player.
//
// This function is serialized (goalsScreenApp.toString()) and served as /telegram-app/v26-goals.js, so it must be
// self-contained: no imports and no references to anything outside of its own body.
// The old v19 openGame() hands over to H.openGameV26 and falls back to the legacy page if this one throws.
export function goalsScreenApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV26) return;
  const S = (window.HOHV26 = { version: "26.1" });
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
      gamePk, ctx: ctx || {}, game: null, extra: null, payload: null,
      openEvent: null, revealed: false, fresh: new Map(), seen: null, openedAt: Date.now(), timer: null, busy: false,
      failedCovers: new Set(),
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
.v26Cover{position:relative;display:block;border-radius:16px;overflow:hidden;aspect-ratio:16/9;background:#0c0e14;border:1px solid var(--v26-line);text-decoration:none}
.v26Cover img{width:100%;height:100%;object-fit:cover;display:block}
.v26CoverTag{position:absolute;left:10px;bottom:10px;display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,.64);color:#fff;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700}
.v26CoverTag svg{width:12px;height:12px;fill:currentColor}
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
.v26When2{text-align:center;font-size:12px;color:var(--v26-muted);font-weight:600;line-height:1.4}
.v26Wl{background:var(--v26-card);border:1px solid #74401f;border-radius:14px;padding:10px;display:grid;grid-template-columns:auto repeat(3,minmax(0,1fr));align-items:center;gap:7px}
html.v15Light .v26Wl{border-color:#e4a176;background:#fff8f2}
.v26WlLogo{display:block;height:24px;width:auto;max-width:92px;object-fit:contain}
.v26Odd{display:grid;gap:1px;justify-items:center;text-decoration:none;color:var(--v26-text);background:var(--v26-card2);border:1px solid var(--v26-line);border-radius:10px;padding:7px 4px;min-height:54px;align-content:center}
.v26Odd small{font-size:11px;color:var(--v26-muted);font-weight:700}
.v26Odd b{font-size:17px;font-weight:800}
.v26Odd i{font-style:normal;font-size:10px;color:var(--v26-muted);font-weight:700}
.v26Odd.won{background:var(--v26-accent);border-color:var(--v26-accent);color:#fff}
.v26Odd.won small,.v26Odd.won i{color:rgba(255,255,255,.88)}
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
.v26Play.off{background:var(--v26-card2);color:var(--v26-muted);opacity:.55;cursor:default}
.v26Spin{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:var(--v26-card2)}
.v26Spin::after{content:"";width:16px;height:16px;border-radius:50%;border:2px solid var(--v26-lav);border-right-color:transparent;animation:v26Rot .9s linear infinite}
@keyframes v26Rot{to{transform:rotate(360deg)}}
.v26Player{display:grid;gap:8px}
.v26Player video{width:100%;aspect-ratio:16/9;border-radius:10px;background:#000;display:block}
.v26Bar{font-size:12px;color:var(--v26-muted);font-weight:600}
.v26Err{font-size:12px;color:var(--v26-live);font-weight:600}
.v26Big{width:100%;border:1px solid var(--v26-line);background:var(--v26-card);color:var(--v26-text);border-radius:12px;padding:12px;font:inherit;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
.v26Big svg{width:16px;height:16px;fill:currentColor}
.v26Note{background:var(--v26-card);border:1px dashed var(--v26-line);border-radius:12px;padding:14px;font-size:13px;color:var(--v26-muted);font-weight:500;text-align:center;line-height:1.45}
.v26Note .v26Big{margin-top:10px}
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

  const hidden = () => noSpoilers() && !state.revealed;

  function scoreText() {
    const p = state.payload;
    const g = state.game;
    const ph = phase();
    if (ph === "upcoming" || ph === "postponed") return "—";
    if (hidden()) return "• : •";
    const away = p && p.teams && p.teams.away.score != null ? p.teams.away.score : g.away_score;
    const home = p && p.teams && p.teams.home.score != null ? p.teams.home.score : g.home_score;
    return `${away == null ? 0 : away} : ${home == null ? 0 : home}`;
  }

  // The cover of our VK broadcast: the copy kept on our server first, the VK picture as the second choice.
  function coverSrc() {
    const p = state.payload;
    if (p && p.cover_url && !state.failedCovers.has(p.cover_url)) return p.cover_url;
    const b = state.extra && state.extra.broadcast;
    if (b && b.source_key) {
      const url = `/api/telegram-center-media/vk-cover?source_key=${encodeURIComponent(b.source_key)}`;
      if (!state.failedCovers.has(url)) return url;
    }
    return "";
  }
  function vkLink() {
    const b = state.extra && state.extra.broadcast;
    return (b && (b.web_url || b.app_url)) || "";
  }

  function coverHtml() {
    const src = coverSrc();
    if (!src) return "";
    const link = vkLink();
    const tag = link ? `<span class="v26CoverTag">${PLAY_SVG}Смотреть в VK Видео</span>` : "";
    const img = `<img src="${esc(src)}" alt="">`;
    return link
      ? `<a class="v26Cover" href="${esc(link)}" data-link="${esc(link)}" target="_blank" rel="noopener">${img}${tag}</a>`
      : `<div class="v26Cover">${img}</div>`;
  }

  function headHtml() {
    const g = state.game;
    const p = state.payload;
    const ph = phase();
    const cover = coverHtml();
    let pill;
    if (ph === "live") pill = `<span class="v26Pill live"><i></i>LIVE${p && p.state.label_ru ? " · " + esc(p.state.label_ru) : ""}</span>`;
    else if (ph === "final") pill = `<span class="v26Pill">${esc((p && p.state.label_ru) || "Финал")}</span>`;
    else if (ph === "postponed") pill = '<span class="v26Pill">Матч перенесён</span>';
    else pill = `<span class="v26Pill">${esc(when(g.scheduled_start_utc))}</span>`;
    const team = (t) =>
      `<button class="v26Team" data-v26-team="${esc(t.tri)}" aria-label="${esc(t.name_ru || t.tri)}">${cover ? "" : `<img src="${esc(t.logo || "")}" alt="">`}<b>${esc(t.tri)}</b><span>${esc(t.name_ru || t.name_en || "")}</span></button>`;
    const shots =
      p && p.teams.away.shots != null && p.teams.home.shots != null && ph !== "upcoming" && !hidden()
        ? `<div class="v26Shots"><span>Броски ${esc(p.teams.away.shots)} : ${esc(p.teams.home.shots)}</span></div>`
        : "";
    const meta = [ph === "upcoming" ? "" : when(g.scheduled_start_utc), g.venue_name || ""].filter(Boolean).join(" · ");
    const vk = !cover && vkLink() ? `<a class="v26Vk" data-link="${esc(vkLink())}" href="${esc(vkLink())}" target="_blank" rel="noopener">Смотреть матч в VK Видео</a>` : "";
    return `${cover}<div class="v26Head"><div class="v26Pills">${pill}</div><div class="v26Teams">${team(g.away)}<div class="v26Score">${esc(scoreText())}</div>${team(g.home)}</div>${shots}${meta ? `<div class="v26When2">${esc(meta)}</div>` : ""}</div>${vk}`;
  }

  // Winline line for the game: П1 Н П2 (home / draw / away). After the game the chip that won on regulation time is orange.
  function winlineHtml() {
    const x = state.extra || {};
    const g = state.game;
    const markets = (x.winline && x.winline.markets) || [];
    const hist = x.historical_odds || null;
    const find = (key) => markets.find((m) => m.outcome_key === key && Number(m.odds) > 1);
    const odds = {
      "1": find("home") ? Number(find("home").odds) : hist && Number(hist.p1) > 1 ? Number(hist.p1) : null,
      X: find("draw") ? Number(find("draw").odds) : hist && Number(hist.x) > 1 ? Number(hist.x) : null,
      "2": find("away") ? Number(find("away").odds) : hist && Number(hist.p2) > 1 ? Number(hist.p2) : null,
    };
    if (!odds["1"] && !odds.X && !odds["2"]) return "";
    const result = hidden() ? null : (state.payload && state.payload.result) || (hist && hist.result) || null;
    const href = `/go/winline?game_pk=${encodeURIComponent(state.gamePk)}`;
    const chip = (key, label, tri) =>
      odds[key]
        ? `<a class="v26Odd${result === key ? " won" : ""}" href="${href}" target="_blank" rel="noopener"><small>${label}</small><b>${odds[key].toFixed(2)}</b><i>${esc(tri)}</i></a>`
        : '<span class="v26Odd"><small>' + label + "</small><b>—</b><i></i></span>";
    return `<div class="v26Wl"><img class="v26WlLogo" src="/broadcast/winline-logo.png?asset=canonical-3" alt="WINLINE">${chip("2", g.away.tri, "победа")}${chip("X", "Н", "ничья")}${chip("1", g.home.tri, "победа")}</div>`;
  }

  function assistsHtml(goal) {
    if (!goal.assists || !goal.assists.length) return '<div class="v26Assist">Без передач</div>';
    const links = goal.assists
      .map((a) => (a.id ? `<button data-v26-player="${esc(a.id)}">${esc(surname(a))}</button>` : esc(surname(a))))
      .join(", ");
    return `<div class="v26Assist">Передачи: ${links}</div>`;
  }

  // The play button of a goal: active with a clip, a spinner while the clip is being cut, grey when there is no video.
  function actionHtml(clip, open, playAttr) {
    if (clip.state === "ready") {
      return `<button class="v26Play${open ? " on" : ""}" ${playAttr} aria-label="${open ? "Закрыть видео" : "Смотреть гол"}">${PLAY_SVG}</button>`;
    }
    if (clip.state === "pending") return '<div class="v26Spin" aria-label="Видео готовится"></div>';
    return `<span class="v26Play off" aria-disabled="true" aria-label="Видео нет">${PLAY_SVG}</span>`;
  }

  function goalHtml(goal) {
    const clip = goal.clip || { state: "none" };
    const open = state.openEvent === goal.event_id;
    const fresh = state.fresh.get(goal.event_id) > Date.now();
    const action = actionHtml(clip, open, `data-play="${esc(goal.event_id)}"`);
    const waitNote = clip.state === "pending" ? '<div class="v26Wait">Видео будет через 3–4 минуты</div>' : "";
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

  function goalsBodyHtml() {
    const ph = phase();
    const p = state.payload;
    if (!p) return '<div class="v26Note">Голы временно недоступны.<button class="v26Big" data-retry="1">Обновить</button></div>';
    if (ph === "upcoming") return '<div class="v26Note">Матч ещё не начался. Голы появятся здесь сразу после первой шайбы.</div>';
    if (ph === "postponed") return '<div class="v26Note">Матч перенесён.</div>';
    if (hidden()) {
      return '<div class="v26Note">Включён режим «без спойлеров». Счёт и голы скрыты.<button class="v26Big" data-reveal="1">Показать голы</button></div>';
    }
    if (!p.goals.length) return `<div class="v26Note">${ph === "live" ? "Пока без голов." : "В этом матче не было голов."}</div>`;
    let notes = "";
    if (!p.clips.server_ok) notes = '<div class="v26Note">Видео временно недоступно, голы показаны без роликов.</div>';
    return `<div class="v26List">${notes}${p.goals.map(goalHtml).join("")}</div>`;
  }

  const goalSlot = () => document.querySelector(`[data-slot="${String(state.openEvent).replace(/"/g, "")}"]`);

  function readyGoal(eventId) {
    const goal = state.payload && state.payload.goals.find((g) => g.event_id === eventId);
    return goal && goal.clip && goal.clip.state === "ready" ? goal : null;
  }

  function playerHtml(clip, label) {
    return `<div class="v26Player"><video controls playsinline webkit-playsinline preload="metadata"${clip.poster_url ? ` poster="${esc(clip.poster_url)}"` : ""} src="${esc(clip.url)}"></video><div class="v26Bar"><span>${esc(label)}</span></div><div class="v26Err" hidden></div></div>`;
  }

  function removePlayer() {
    document.querySelectorAll(".v26Player").forEach((el) => {
      const v = el.querySelector("video");
      if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) { /* ignore */ } }
      el.remove();
    });
  }

  function mountClip(slot, clip, label, autoplay) {
    if (!slot) return;
    removePlayer();
    slot.innerHTML = playerHtml(clip, label);
    const video = slot.querySelector("video");
    video.addEventListener("error", () => {
      const err = slot.querySelector(".v26Err");
      if (err) { err.hidden = false; err.textContent = "Не удалось загрузить видео. Проверьте соединение."; }
    });
    if (autoplay) {
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => { /* the user can press play */ });
    }
  }

  function mountPlayer(autoplay) {
    const goal = readyGoal(state.openEvent);
    if (goal) mountClip(goalSlot(), goal.clip, "Гол, празднование и повторы", autoplay);
  }

  function paintHead() {
    const el = document.getElementById("v26Head");
    if (el) el.innerHTML = headHtml();
  }
  function paintWinline() {
    const el = document.getElementById("v26Wl");
    if (el) el.innerHTML = winlineHtml();
  }
  function paintBody() {
    const body = document.getElementById("v26Body");
    if (!body) return;
    const keep = body.querySelector(".v26Player");
    if (keep) keep.remove();
    body.innerHTML = goalsBodyHtml();
    if (keep) {
      const slot = goalSlot();
      if (slot) slot.appendChild(keep);
    }
  }
  function paintAll() {
    paintHead();
    paintWinline();
    paintBody();
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

  function openLink(url) {
    try {
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) window.Telegram.WebApp.openLink(url, { try_instant_view: false });
      else window.location.href = url;
    } catch (e) { window.location.href = url; }
  }

  function onClick(event) {
    const target = event.target.closest("[data-v26-team],[data-v26-player],[data-play],[data-reveal],[data-retry],[data-link]");
    if (!target) return;
    if (target.dataset.link) {
      event.preventDefault();
      openLink(target.dataset.link);
      return;
    }
    if (target.dataset.v26Team) { if (H.openTeam) leaveTo(() => H.openTeam(target.dataset.v26Team)); return; }
    if (target.dataset.v26Player) { if (H.openPlayer) leaveTo(() => H.openPlayer(Number(target.dataset.v26Player))); return; }
    if (target.dataset.reveal) { state.revealed = true; paintAll(); return; }
    if (target.dataset.retry) { reloadPayload(true); return; }
    if (target.dataset.play) {
      const id = Number(target.dataset.play);
      const closing = state.openEvent === id;
      removePlayer();
      state.openEvent = closing ? null : id;
      paintBody();
      if (!closing) mountPlayer(true);
    }
  }

  // A cover that fails to load is remembered and the next choice (or the logos) takes its place.
  function onImageError(event) {
    const img = event.target;
    if (!img || img.tagName !== "IMG" || !img.closest || !img.closest(".v26Cover")) return;
    const src = img.getAttribute("src") || "";
    if (state.failedCovers.has(src)) return;
    state.failedCovers.add(src);
    paintHead();
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
    paintAll();
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
    // "v15Profile" is what the settings layer looks for to put the eye and the gear on the same row as the back button.
    root.innerHTML = `<div class="v15Profile v26Match" id="v26Root">${H.backRow("Матч")}<div id="v26Head"></div><div id="v26Wl"></div><div id="v26Body"></div></div>`;
    const backButton = document.getElementById("v15Back");
    if (backButton) backButton.onclick = back;
    const rootEl = document.getElementById("v26Root");
    rootEl.addEventListener("click", onClick);
    rootEl.addEventListener("error", onImageError, true);
    paintAll();
    schedule();
  }

  window.addEventListener("hoh-spoilers-change", () => {
    if (document.getElementById("v26Root")) paintAll();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.getElementById("v26Root") && state.timer) tick();
  });

  // ---- every goal of one player in the season: a page reached from the player profile ----------------------------------
  const pg = { id: null, payload: null, openKey: null, revealed: false };
  S.pg = pg;
  const pgKey = (g) => `${g.game_pk}:${g.event_id}`;
  const pgGoal = (key) => (pg.payload && pg.payload.goals.find((g) => pgKey(g) === key)) || null;

  function dayText(iso) {
    const d = new Date(`${iso}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  }
  const seasonText = (id) => (/^\d{8}$/.test(String(id)) ? `${String(id).slice(0, 4)}/${String(id).slice(6)}` : "");

  function pgGoalHtml(g) {
    const key = pgKey(g);
    const open = pg.openKey === key;
    const sa = g.score_after || {};
    const where = g.team && g.home ? (g.team === g.home ? "дома" : "в гостях") : "";
    const tags = [where, g.strength_label_ru, g.modifier_label_ru].filter(Boolean).map((t) => `<span class="v26Tag">${esc(t)}</span>`).join("");
    const clip = g.clip || { state: "none" };
    return `<div class="v26Goal" data-pg-goal="${esc(key)}"><div class="v26Row"><div class="v26When"><small>${esc(g.period.short_ru)}</small><b>${esc(g.time || "")}</b></div><div class="v26Who"><div class="v26WhoTop"><span class="v26Tri">${esc(g.team || "")}</span>${tags}</div><div class="v26Assist">Счёт после гола ${esc(sa.away)}:${esc(sa.home)}</div></div><div class="v26Right">${actionHtml(clip, open, `data-pg-play="${esc(key)}"`)}</div></div><div data-pg-slot="${esc(key)}"></div></div>`;
  }

  function pgBodyHtml() {
    const p = pg.payload;
    if (!p) return '<div class="v26Note">Голы игрока временно недоступны.<button class="v26Big" data-pg-retry="1">Обновить</button></div>';
    if (noSpoilers() && !pg.revealed) {
      return '<div class="v26Note">Включён режим «без спойлеров». Голы игрока скрыты.<button class="v26Big" data-pg-reveal="1">Показать голы</button></div>';
    }
    let notes = "";
    if (!p.server_ok) notes += '<div class="v26Note">Видео временно недоступно, голы показаны без роликов.</div>';
    if (p.missing > 0) notes += `<div class="v26Note">Не удалось загрузить подробности ${esc(p.missing)} ${p.missing === 1 ? "гола" : "голов"}. Попробуйте обновить страницу чуть позже.</div>`;
    if (p.truncated) notes += '<div class="v26Note">Показаны голы в последних матчах сезона.</div>';
    if (!p.goals.length) return `${notes}<div class="v26Note">В этом сезоне голов пока нет.</div>`;
    let html = "";
    let lastGame = null;
    for (const g of p.goals) {
      if (g.game_pk !== lastGame) {
        lastGame = g.game_pk;
        html += `<button class="v26GameHead" data-pg-game="${esc(g.game_pk)}"><span>${esc(dayText(g.date))}</span><b>${esc(g.away || "")} — ${esc(g.home || "")}</b><i>Матч ›</i></button>`;
      }
      html += pgGoalHtml(g);
    }
    return `<div class="v26List">${notes}${html}</div>`;
  }

  function pgHeroHtml() {
    const p = pg.payload;
    const name = (p && p.player && (p.player.name_ru || p.player.name_en)) || "Игрок";
    let line = "";
    if (p && !(noSpoilers() && !pg.revealed)) {
      const season = seasonText(p.season);
      line = `${season ? `Сезон ${season}` : "Сезон"}: ${p.total} ${p.total === 1 ? "гол" : p.total >= 2 && p.total <= 4 ? "гола" : "голов"}`;
      if (p.server_ok && p.total) line += ` · с видео: ${p.with_video}`;
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
    const open = pgGoal(pg.openKey);
    if (open && open.clip.state === "ready") pgMount(pg.openKey, false);
    else pg.openKey = null;
  }

  function pgMount(key, autoplay) {
    const goal = pgGoal(key);
    const slot = document.querySelector(`[data-pg-slot="${String(key).replace(/"/g, "")}"]`);
    if (!goal || !slot || goal.clip.state !== "ready") return;
    mountClip(slot, goal.clip, `${dayText(goal.date)} · ${goal.away || ""} — ${goal.home || ""}`, autoplay);
  }

  function pgBack() {
    const v23 = window.HOHV23;
    if (v23 && typeof v23.renderMain === "function" && v23.current) return v23.renderMain(v23.current);
    return H.goBack();
  }

  function pgClick(event) {
    const target = event.target.closest("[data-pg-play],[data-pg-game],[data-pg-reveal],[data-pg-retry]");
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
    Object.assign(pg, { id: playerId, payload: null, openKey: null, revealed: false });
    H.state.profile = true;
    const root = H.view();
    if (!root) return;
    root.innerHTML = '<div class="v15Loading">Загрузка голов…</div>';
    try {
      const res = await H.api(`${API}/players/${playerId}/goals`);
      if (res && res.ok !== false) pg.payload = res;
    } catch (e) { console.warn("v26 player goals failed", e); }
    root.innerHTML = `<div class="v15Profile v26Match" id="v26PgRoot">${H.backRow("Голы игрока")}<div id="v26PgHero"></div><div id="v26PgBody"></div></div>`;
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
