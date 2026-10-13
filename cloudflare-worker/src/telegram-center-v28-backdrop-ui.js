// Live Center v28: the backdrop of the whole app (a light silhouette of a real player behind the cards, different on every screen and
// every day) and two touches of the players tab: a big number on the right and a small follow button next to it.
//
// This function is serialized (backdropApp.toString()) and served as /telegram-app/v28-backdrop.js, so it must be
// self-contained: no imports and no references to anything outside of its own body.
export function backdropApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV28) return;
  const S = (window.HOHV28 = { version: "28.0" });

  // The silhouettes are cut from the official action shots of the NHL and kept as flat shapes: /telegram-app/bg/<key>.webp
  const POOL = [
    { k: "kaprizov", id: 8478864, tri: "MIN" },
    { k: "ovechkin", id: 8471214, tri: "WSH" },
    { k: "kucherov", id: 8476453, tri: "TBL" },
    { k: "panarin", id: 8478550, tri: "LAK" },
    { k: "malkin", id: 8471215, tri: "PIT" },
    { k: "sergachev", id: 8479410, tri: "UTA" },
    { k: "shesterkin", id: 8478048, tri: "NYR" },
    { k: "svechnikov", id: 8480830, tri: "CAR" },
    { k: "michkov", id: 8484387, tri: "PHI" },
    { k: "crosby", id: 8471675, tri: "PIT" },
    { k: "mackinnon", id: 8477492, tri: "COL" },
    { k: "matthews", id: 8479318, tri: "TOR" },
  ];
  const PREF = "hoh-bg-sil";
  const V2 = H.V2 || "/api/telegram-center-v2";

  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
  };
  const enabled = () => store.get(PREF) !== "0";
  const esc = (v) => (H.esc ? H.esc(v) : String(v == null ? "" : v));

  // ---- styles ----------------------------------------------------------------------------------------------------------------
  function css() {
    if (document.getElementById("v28css")) return;
    const style = document.createElement("style");
    style.id = "v28css";
    style.textContent = `
html{--sil-a:#6d32e8;--sil-b:#b597ff;--sil-op:.48}
html:not(.v15Light){--sil-a:#d4c6ff;--sil-b:#7a5ae6;--sil-op:.4}
#hohSil{position:fixed;z-index:0;top:7vh;bottom:-1vh;width:min(150vw,880px);pointer-events:none;opacity:0;transition:opacity .6s ease;background:linear-gradient(165deg,var(--sil-a),var(--sil-b));-webkit-mask-image:var(--sil-img);mask-image:var(--sil-img);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-size:contain;mask-size:contain}
#hohSil[data-side="right"]{right:-14vw;-webkit-mask-position:right 38%;mask-position:right 38%}
#hohSil[data-side="left"]{left:-14vw;-webkit-mask-position:left 38%;mask-position:left 38%}
#hohSil.on{opacity:var(--sil-op)}
html:not(.hohSil) #hohSil{display:none}
html.hohSil .app{background:transparent!important}
html.hohSil{--hoh-glass-light:rgba(255,255,255,.44);--hoh-glass-light-strong:rgba(255,255,255,.6);--hoh-glass-dark:rgba(14,16,24,.46);--hoh-glass-dark-strong:rgba(10,12,19,.62);--hoh-blur:blur(1.5px)}
html.hohSil.v15Light .v27Home,html.hohSil.v15Light .v27NewsPage,html.hohSil.v15Light .v27Settings{--c-card:rgba(255,255,255,.42);--c-card2:rgba(241,242,247,.42)}
html.hohSil:not(.v15Light) .v27Home,html.hohSil:not(.v15Light) .v27NewsPage,html.hohSil:not(.v15Light) .v27Settings{--c-card:rgba(16,18,26,.44);--c-card2:rgba(23,26,36,.44)}
html.hohSil :is(.v27Hero,.v27NewsList,.v27Article,.v27Settings){-webkit-backdrop-filter:blur(1.5px);backdrop-filter:blur(1.5px)}
html.hohSil body:before{background-image:linear-gradient(135deg,rgba(190,163,234,.66),rgba(226,217,244,.5) 47%,rgba(241,237,247,.64))!important;background-size:auto!important;background-blend-mode:normal!important;filter:none!important;opacity:.62!important;transform:none!important}
html.hohSil:not(.v15Light) body:before{background-image:linear-gradient(135deg,rgba(86,60,123,.8),rgba(28,26,43,.74) 48%,rgba(8,10,17,.9))!important;opacity:.7!important}
.playerRow .playerSortValue{display:flex!important;flex-direction:column;align-items:flex-end;justify-content:center;gap:1px;min-width:50px;color:#5b21b6!important;font-weight:900!important;line-height:1}
html:not(.v15Light) .playerRow .playerSortValue{color:#cdb9ff!important}
.playerRow .playerSortValue b{font-size:25px;font-weight:900;letter-spacing:-.4px;line-height:1}
html .playerRow .playerSortValue b{color:inherit!important}
.playerRow .playerSortValue small{font-size:11px;font-weight:800;letter-spacing:0;opacity:.8;text-transform:none}
.v28Fol{flex:0 0 auto;display:grid;place-items:center;width:30px;height:30px;margin:0 6px 0 4px;padding:0;border-radius:50%;border:1px solid #b7a6e6;background:rgba(255,255,255,.7);color:#5b21b6;font:inherit;font-size:19px;font-weight:700;line-height:1;cursor:pointer}
html:not(.v15Light) .v28Fol{border-color:#464a59;background:rgba(23,25,34,.8);color:#d9ccff}
.v28Fol.on{background:#dff5ea;border-color:#68c79a;color:#17784f}
html:not(.v15Light) .v28Fol.on{background:#123429;border-color:#347e63;color:#62e6ae}
.v28Fol[disabled]{opacity:.5}
`;
    document.head.appendChild(style);
  }

  // ---- the silhouette --------------------------------------------------------------------------------------------------------
  const hash = (text) => {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
  };
  const dayIndex = () => Math.floor(Date.now() / 86400000);
  const triOfLogo = (img) => {
    const m = /\/logos\/nhl\/svg\/([A-Z]{2,3})_/.exec((img && img.getAttribute("src")) || "");
    return m ? m[1] : null;
  };

  // what the person looks at now: the screen and, where it has them, the teams and the player of the page
  function screen() {
    const view = H.view();
    if (!view) return { key: "home" };
    if (view.querySelector("#v26Root")) {
      const tris = [...view.querySelectorAll("#v26Root img")].map(triOfLogo).filter(Boolean);
      return { key: `match:${tris.join("-")}`, tris };
    }
    const player = view.querySelector(".v23PlayerProfile, .v19PlayerProfile");
    if (player) {
      const src = [...player.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").find((s) => /\/mugs\/nhl\/\d+\/[A-Z]{2,3}\/\d+\.png/.test(s)) || "";
      const m = /\/mugs\/nhl\/\d+\/([A-Z]{2,3})\/(\d+)\.png/.exec(src);
      return m ? { key: `player:${m[2]}`, id: Number(m[2]), tris: [m[1]] } : { key: "player" };
    }
    if (view.querySelector(".v27NewsPage")) return { key: "news" };
    if (view.querySelector(".v15Profile")) {
      const tri = [...view.querySelectorAll(".v15Profile img")].map(triOfLogo).find(Boolean);
      return tri ? { key: `team:${tri}`, tris: [tri] } : { key: "page" };
    }
    if (H.state && H.state.profile) return { key: "page" };
    return { key: H.currentTab() || "home" };
  }

  function choose(sc) {
    const own = sc.id ? POOL.find((p) => p.id === sc.id) : null;
    if (own) return own;
    for (const tri of sc.tris || []) {
      const mates = POOL.filter((p) => p.tri === tri);
      if (mates.length) return mates[(dayIndex() + hash(sc.key)) % mates.length];
    }
    return POOL[(hash(sc.key) + dayIndex()) % POOL.length];
  }

  let layer = null;
  let current = "";
  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.getElementById("hohSil");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "hohSil";
      layer.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(layer);
    }
    return layer;
  }

  function update() {
    document.documentElement.classList.toggle("hohSil", enabled());
    if (!enabled()) return;
    const el = ensureLayer();
    const sc = screen();
    const pick = choose(sc);
    const side = hash(`${sc.key}:side`) % 2 ? "left" : "right";
    const id = `${pick.k}:${side}`;
    if (id === current) return;
    const first = !current;
    current = id;
    // the pictures are cached for a week: a new set of pictures needs a new number here
    const url = `/telegram-app/bg/${pick.k}.webp?v=2`;
    el.classList.remove("on");
    // the new picture is loaded first, so the swap never shows an empty frame
    const swap = () => {
      if (current !== id) return;
      el.style.setProperty("--sil-img", `url("${url}")`);
      el.dataset.side = side;
      el.dataset.sil = pick.k;
      el.classList.add("on");
    };
    const img = new Image();
    img.onload = img.onerror = () => setTimeout(swap, first ? 0 : 320);
    img.src = url;
  }

  // ---- players tab: a follow button next to the number ----------------------------------------------------------------------
  const follows = { map: null, at: 0, ok: false, busy: null };
  function loadFollows(force) {
    if (!force && follows.map && Date.now() - follows.at < 5 * 60 * 1000) return Promise.resolve(follows.map);
    if (follows.busy) return follows.busy;
    follows.busy = (async () => {
      const map = new Map();
      try {
        const d = await H.api(`${V2}/subscriptions`);
        if (d && d.ok !== false && Array.isArray(d.subscriptions)) {
          follows.ok = true;
          for (const s of d.subscriptions) if (s.subject_type === "player") map.set(Number(s.subject_key), Number(s.subscription_id));
        } else follows.ok = false;
      } catch (e) {
        follows.ok = false; // not inside Telegram: the buttons stay, a tap explains why nothing happens
      }
      follows.map = map;
      follows.at = Date.now();
      follows.busy = null;
      return map;
    })();
    return follows.busy;
  }

  function paintButton(btn) {
    const on = follows.map && follows.map.has(Number(btn.dataset.v28Fol));
    btn.classList.toggle("on", Boolean(on));
    btn.textContent = on ? "✓" : "+";
    btn.setAttribute("aria-label", on ? "Вы подписаны на игрока. Нажмите, чтобы отписаться" : "Подписаться на игрока");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const paintButtons = () => document.querySelectorAll(".v28Fol").forEach(paintButton);

  async function toggle(btn) {
    const id = Number(btn.dataset.v28Fol);
    btn.disabled = true;
    try {
      const map = await loadFollows();
      if (!follows.ok) {
        alert("Подписки доступны при открытии из Telegram-бота");
        return;
      }
      const sid = map.get(id);
      if (sid) {
        await H.api(`${V2}/subscriptions/${sid}`, { method: "DELETE" });
        map.delete(id);
      } else {
        const d = await H.api(`${V2}/subscriptions`, { method: "POST", body: JSON.stringify({ type: "player", key: String(id) }) });
        const row = d && d.subscription;
        if (row && row.subscription_id) map.set(id, Number(row.subscription_id));
      }
      paintButtons();
      window.dispatchEvent(new Event("hoh-follows-change"));
    } catch (e) {
      alert((e && e.message) || "Не удалось изменить подписку");
    } finally {
      btn.disabled = false;
    }
  }

  // the number on the right becomes big: the value and, smaller, what it is ("млн", "лет", "см")
  function splitValue(box) {
    if (box.dataset.v28) return;
    box.dataset.v28 = "1";
    const text = String(box.textContent || "").trim();
    const m = /^(-?[\d.,]+)\s*(.*)$/.exec(text);
    box.innerHTML = m ? `<b>${esc(m[1])}</b>${m[2] ? `<small>${esc(m[2])}</small>` : ""}` : `<b>${esc(text)}</b>`;
  }

  function decoratePlayers() {
    const rows = document.querySelectorAll("#view .playerRow[data-player]");
    if (!rows.length) return;
    let added = false;
    rows.forEach((row) => {
      const value = row.querySelector(".playerSortValue");
      if (!value) return;
      splitValue(value);
      if (row.querySelector(".v28Fol")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "v28Fol";
      btn.dataset.v28Fol = row.dataset.player;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // the row itself opens the player
        toggle(btn);
      });
      paintButton(btn);
      value.before(btn);
      added = true;
    });
    if (added || !follows.map) loadFollows().then(paintButtons);
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------------------
  const oldRun = H.runCore;
  H.runCore = function () {
    const result = typeof oldRun === "function" ? oldRun.apply(this, arguments) : undefined;
    setTimeout(() => { update(); decoratePlayers(); }, 60);
    return result;
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".tab")) setTimeout(() => { update(); decoratePlayers(); }, 160);
  }, true);
  // The players list is drawn again on every change of the sort, the team or the country, and a player or a match opens without
  // runCore: whatever changes on the page, the silhouette and the buttons catch up a moment later.
  let pending = null;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        update();
        decoratePlayers();
      }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("hoh-bg-sil-change", () => {
    current = "";
    update();
  });
  window.addEventListener("hoh-follows-change", () => {
    if (follows.map) follows.at = 0; // another layer changed the follows: ask again next time
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") update();
  });

  S.update = update;
  S.screen = screen;
  S.choose = choose;
  S.pool = POOL;
  css();
  update();
  setTimeout(update, 400);
  setTimeout(() => { update(); decoratePlayers(); }, 1200);
}
