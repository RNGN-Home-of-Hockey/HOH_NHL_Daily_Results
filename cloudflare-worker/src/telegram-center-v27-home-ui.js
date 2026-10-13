// Live Center home page (v27): score strip of the day, match of the day, goal clips, three news and the latest videos, plus the news page.
//
// This function is serialized (homeScreenApp.toString()) and served as /telegram-app/v27-home.js, so it must be
// self-contained: no imports and no references to anything outside of its own body.
//
// The page owns the "Главное" tab. The older layers (v15/v16 videos, v20 news and match of the day) look at window.HOHV27.owns()
// and stay quiet while it is true; if the home answer cannot be loaded twice in a row owns() turns false and the old home takes over.
export function homeScreenApp() {
  const H = window.HOHV15;
  if (!H || window.HOHV27) return;
  const S = (window.HOHV27 = { version: "27.0", failed: false });
  S.owns = () => !S.failed;

  const API = "/api/telegram-center-v27";
  const NEWS_API = "/api/telegram-center-v20";
  const MEDIA_API = "/api/telegram-center-v12";
  const POLL_LIVE_MS = 15000;
  const POLL_IDLE_MS = 60000;
  const NEWS_TTL_MS = 5 * 60 * 1000;
  const MEDIA_TTL_MS = 5 * 60 * 1000;
  const HOME_NEWS_COUNT = 3;
  const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const VK_ROOTS = ["vkvideo.ru", "vk.com", "vk.ru", "userapi.com", "vkuser.net", "vk-cdn.net", "vkuserphoto.ru", "vkuserlive.net", "vkuseraudio.net", "vkusercontent.net"];

  const FOLLOWS_TTL_MS = 5 * 60 * 1000;
  const MAX_PLAYER_LOOKUPS = 8;
  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* private window: the choice is kept until the page closes */ }
    },
  };

  const st = (S.state = {
    data: null, news: null, newsAt: 0, media: null, mediaAt: 0, busy: false, fails: 0, timer: null, lastAt: 0,
    revealed: false, sections: {}, queue: [], goalIndex: -1, openNewsId: null,
    follows: null, followsAt: 0, playerTeams: new Map(), mineOnly: store.get("hoh-home-mine") === "1", hintHidden: store.get("hoh-home-hint") === "1",
    // what the person switched on in the settings: the home page is the same for everybody until then
    prefs: { russians: store.get("hoh-home-russians") !== "0", mine: store.get("hoh-home-mine-on") === "1" },
  });
  const PREF_STORE = { russians: "hoh-home-russians", mine: "hoh-home-mine-on" };

  // ---- helpers ---------------------------------------------------------------------------------------------------------------
  const esc = (v) =>
    H.esc
      ? H.esc(v)
      : String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const noSpoilers = () => typeof window.HOHNoSpoilers === "function" && window.HOHNoSpoilers() === true;
  const n0 = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
  const pad2 = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const localToday = () => dayKey(new Date());
  const shortDate = (day) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
  };
  const prevDay = (day) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const clock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };
  const whenWord = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date();
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (diff === 0) return "сегодня";
    if (diff === 1) return "завтра";
    if (diff === -1) return "вчера";
    return shortDate(dayKey(d));
  };
  const plural = (n, one, few, many) => {
    const x = Math.abs(Number(n)) % 100;
    const y = x % 10;
    return x > 10 && x < 20 ? many : y === 1 ? one : y >= 2 && y <= 4 ? few : many;
  };
  const surname = (name) => {
    const parts = String(name || "").trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : parts[0] || "";
  };
  const ago = (v) => {
    const t = Date.parse(v);
    if (!t) return "";
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 2) return "только что";
    if (m < 60) return `${m} мин назад`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч назад`;
    const d = Math.floor(h / 24);
    if (d === 1) return "вчера";
    if (d < 7) return `${d} дн. назад`;
    return shortDate(dayKey(new Date(t)));
  };
  const fullDate = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  };
  const duration = (s) => {
    const n = Math.round(Number(s) || 0);
    return n > 0 ? `${Math.floor(n / 60)}:${pad2(n % 60)}` : "";
  };
  // only plain web links are ever put into a href
  const webUrl = (v) => {
    try {
      const u = new URL(String(v || ""));
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
    } catch (e) {
      return "";
    }
  };
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "источнике";
    }
  };
  const homeAllowed = () => !H.state.profile && H.currentTab() === "games" && H.tabsVisible();
  const home = () => {
    const root = H.view();
    return root ? root.querySelector(":scope > .v27Home") : null;
  };
  const colon = "&thinsp;:&thinsp;";
  const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const CHAT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z"/></svg>';

  function vkCover(v, key) {
    const k = String(key || "").trim();
    if (k) return `/api/telegram-center-media/vk-cover?source_key=${encodeURIComponent(k)}`;
    const s = String(v || "").trim();
    if (!s) return "";
    try {
      const host = new URL(s, location.href).hostname.toLowerCase();
      if (VK_ROOTS.some((r) => host === r || host.endsWith(`.${r}`))) return `/api/telegram-center-media/vk-cover?url=${encodeURIComponent(s)}`;
    } catch (e) { /* not a URL: use as is */ }
    return s;
  }
  const failures = () => (window.HOHCoverFailures = window.HOHCoverFailures || new Set());
  function coverSrc(g) {
    const bad = failures();
    if (g.cover_url && !bad.has(g.cover_url)) return g.cover_url;
    if (g.thumbnail_url) {
      const u = vkCover(g.thumbnail_url, g.vk && g.vk.source_key);
      if (u && !bad.has(u)) return u;
    }
    return "";
  }

  // ---- my teams and players: the follows of the person -----------------------------------------------------------------------
  // Only inside Telegram the person is known; anywhere else the list comes back empty and the page stays the same for everybody.
  const norm = (v) => String(v || "").toLowerCase().replace(/ё/g, "е");
  const stem = (word) => {
    const s = norm(word);
    return s.length >= 7 ? s.slice(0, -2) : s.length === 6 ? s.slice(0, -1) : s;
  };
  const mineOn = () => st.prefs.mine === true;
  const followed = () => mineOn() && st.follows && st.follows.ok && (st.follows.teams.size > 0 || st.follows.players.size > 0);
  const myPlayers = () => (mineOn() && st.follows ? st.follows.players : new Map());
  function playerTeam(id) {
    if (st.playerTeams.has(id)) return st.playerTeams.get(id);
    const found = ((st.data && st.data.russians && st.data.russians.items) || []).find((x) => x.player_id === id);
    return found ? found.team : null;
  }
  function myTeams() {
    const set = new Set();
    if (!mineOn() || !st.follows) return set;
    st.follows.teams.forEach((t) => set.add(t));
    st.follows.players.forEach((name, id) => {
      const t = playerTeam(id);
      if (t) set.add(t);
    });
    return set;
  }
  const nickOf = (name) => {
    const words = String(name || "").trim().split(/\s+/);
    return words[words.length - 1] || "";
  };
  // why a game is "mine": a team I follow plays in it, or a player I follow does; the first reason is shown on the card
  function mineReason(g) {
    if (!mineOn() || !st.follows) return "";
    const tris = [g.away && g.away.tri, g.home && g.home.tri].map((t) => String(t || "").toUpperCase());
    for (const tri of tris) {
      if (st.follows.teams.has(tri)) return nickOf(st.follows.teamNames.get(tri)) || tri;
    }
    for (const [id, name] of st.follows.players) {
      const tri = playerTeam(id);
      if (tri && tris.includes(tri)) return surname(name) || name;
    }
    return "";
  }
  function mineTokens() {
    const out = [];
    if (!mineOn() || !st.follows) return out;
    st.follows.teamNames.forEach((name) => {
      const words = String(name || "").trim().split(/\s+/);
      const nick = words[words.length - 1];
      if (nick && nick.length >= 4) out.push(stem(nick));
      const city = words.slice(0, -1).join(" ");
      if (city.length >= 4 && !/^нью-йорк$/i.test(city)) out.push(stem(city));
    });
    st.follows.players.forEach((name) => {
      const longest = String(name || "").trim().split(/\s+/).slice(1).sort((a, b) => b.length - a.length)[0] || "";
      if (longest.length >= 4) out.push(stem(longest));
    });
    return [...new Set(out)];
  }
  function newsIsMine(x) {
    const tokens = mineTokens();
    if (!tokens.length) return false;
    const title = norm(x.title);
    return tokens.some((token) => title.includes(token));
  }

  // ---- styles ----------------------------------------------------------------------------------------------------------------
  function css() {
    if (document.getElementById("v27css")) return;
    const style = document.createElement("style");
    style.id = "v27css";
    style.textContent = `
.v27Home{--c-card:#10121a;--c-card2:#171a24;--c-line:#282b38;--c-text:#f7f7fb;--c-muted:#9094a8;--c-accent:#ff5a00;--c-lav:#b58aff;--c-live:#ff4d5e;display:grid;gap:18px;color:var(--c-text);min-width:0;padding-bottom:6px}
html.v15Light .v27Home,html.v15Light .v27NewsPage{--c-card:#ffffff;--c-card2:#f1f2f7;--c-line:#e2e4ec;--c-text:#0c0d14;--c-muted:#686c7e;--c-lav:#7a3df0;--c-live:#e5243b}
.v27Home>*{min-width:0}
.v27Home~*{display:none!important}
.v27Sec[hidden]{display:none}
.v27Head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 2px 9px}
.v27Head b{font-size:16px;font-weight:800;letter-spacing:-.1px}
.v27Head small{font-size:12px;color:var(--c-muted)}
.v27Head button{border:0;background:none;padding:2px 0;font-size:13px;font-weight:700;color:var(--c-lav);cursor:pointer}
.v27Live{display:inline-flex;align-items:center;gap:5px;color:var(--c-live);font-weight:800;font-size:11px;letter-spacing:.5px}
.v27Live i,.v27LiveBadge i{display:block;width:6px;height:6px;border-radius:50%;background:currentColor;animation:v27Pulse 1.3s ease-in-out infinite}
@keyframes v27Pulse{50%{opacity:.25}}
.v27Strip,.v27Shelf{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x proximity;margin:0 -2px;padding:2px 2px 4px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.v27Strip::-webkit-scrollbar,.v27Shelf::-webkit-scrollbar{display:none}
.v27Chip{display:grid;align-content:start;gap:5px;justify-items:center;padding:9px 6px 8px;border:1px solid var(--c-line);border-radius:14px;background:var(--c-card);color:inherit;cursor:pointer;font:inherit}
.v27Chip.live{border-color:var(--c-live);background:linear-gradient(180deg,rgba(255,77,94,.12),transparent 70%),var(--c-card)}
.v27Chip.done{background:var(--c-card2)}
.v27ChipTop{font-size:11px;font-weight:700;color:var(--c-muted);min-height:14px;display:flex;align-items:center}
.v27ChipMid{display:flex;align-items:center;justify-content:center;gap:6px}
.v27ChipMid img{width:26px;height:26px;object-fit:contain;flex:0 0 26px}
.v27ChipMid b{font-size:16px;font-weight:800;white-space:nowrap}
.v27ChipMid b.dash{color:var(--c-muted);font-weight:600}
.v27ChipTri{font-size:11px;color:var(--c-muted);font-weight:600;letter-spacing:.3px}
.v27ChipMore{flex:0 0 76px;scroll-snap-align:start;display:grid;place-items:center;border:1px dashed var(--c-line);border-radius:14px;background:none;color:var(--c-lav);font:inherit;font-size:13px;font-weight:700;cursor:pointer;text-align:center;padding:6px}
.v27Hero{border:1px solid var(--c-line);border-radius:18px;background:var(--c-card);overflow:hidden;cursor:pointer}
.v27HeroCover{position:relative;aspect-ratio:16/9;background:#0c0e14;overflow:hidden}
.v27HeroCover img{width:100%;height:100%;object-fit:cover;display:block}
.v27LiveBadge{display:inline-flex;align-items:center;gap:6px;background:#ff2d46;color:#fff;border-radius:999px;padding:5px 12px;font-size:13px;font-weight:800;letter-spacing:.6px}
.v27HeroCover .v27LiveBadge{position:absolute;left:10px;top:10px}
.v27HeroBody{padding:12px 12px 12px;display:grid;gap:12px}
.v27Kicker{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--c-lav)}
.v27Kicker span{color:var(--c-muted);font-weight:600;letter-spacing:0;text-transform:none;font-size:12px}
.v27HeroTeams{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px}
.v27HeroTeams>div{text-align:center;min-width:0}
.v27HeroTeams img{width:52px;height:52px;object-fit:contain}
.v27HeroTeams .nm{display:block;margin-top:5px;font-size:13px;font-weight:700;line-height:1.2}
.v27HeroMid{display:grid;gap:3px;justify-items:center;min-width:76px}
.v27HeroMid strong{font-size:26px;font-weight:800;line-height:1;white-space:nowrap}
.v27HeroMid small{font-size:11px;color:var(--c-muted);font-weight:600;text-align:center}
.v27Wl{display:grid;grid-template-columns:auto repeat(3,minmax(0,1fr));align-items:center;gap:6px;padding:8px;border:1px solid #74401f;border-radius:12px;background:rgba(255,90,0,.07)}
.v27Wl img{display:block;height:18px;width:auto;max-width:74px;object-fit:contain}
.v27Odd{display:grid;place-items:center;gap:1px;min-height:40px;border:1px solid var(--c-line);border-radius:9px;background:var(--c-card);color:inherit;text-decoration:none}
.v27Odd span{font-size:11px;color:var(--c-muted)}
.v27Odd b{font-size:14px;font-weight:800}
.v27Cta{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border-radius:12px;background:rgba(25,118,210,.12);border:1px solid #2d6ba7;color:#4d9ce7!important;text-decoration:none;font-size:14px;font-weight:800}
html.v15Light .v27Cta{color:#1565c0!important}
html.v15Light .v27Wl{border-color:#e4a176;background:#fff7f0}
.v27Poster{position:relative;display:block;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:radial-gradient(circle at 50% 40%,#2b3040,#12141c 75%)}
.v27Poster img.cover{width:100%;height:100%;object-fit:cover;display:block}
.v27Poster .logos{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px}
.v27Poster .logos img{width:30px;height:30px;object-fit:contain;opacity:.9}
.v27Poster .play{position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(0,0,0,.55);display:grid;place-items:center}
.v27Poster .play svg{width:16px;height:16px;fill:#fff;margin-left:2px}
.v27Poster em{position:absolute;right:6px;bottom:6px;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.65);color:#fff;font-style:normal;font-size:11px;font-weight:700}
.v27Goal{flex:0 0 150px;scroll-snap-align:start;display:grid;gap:5px;align-content:start;padding:0;border:0;background:none;color:inherit;text-align:left;font:inherit;cursor:pointer}
.v27Goal .nm{font-size:14px;font-weight:800;line-height:1.2;padding:0 2px}
.v27Goal .sc{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;padding:0 2px}
.v27Goal .sc img{width:16px;height:16px;object-fit:contain}
.v27Goal .tm{font-size:11px;color:var(--c-muted);padding:0 2px}
.v27Note{display:grid;gap:10px;justify-items:start;padding:14px;border:1px dashed var(--c-line);border-radius:14px;color:var(--c-muted);font-size:13px;line-height:1.4}
.v27Note button{border:1px solid var(--c-line);border-radius:10px;background:var(--c-card2);color:var(--c-text);padding:9px 14px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.v27NewsList{display:grid;border:1px solid var(--c-line);border-radius:16px;background:var(--c-card);overflow:hidden}
.v27News{display:grid;gap:5px;padding:12px 13px;border:0;border-top:1px solid var(--c-line);background:none;color:inherit;text-align:left;font:inherit;cursor:pointer;width:100%}
.v27News:first-child{border-top:0}
.v27NTitle{font-size:14.5px;font-weight:650;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.v27NMeta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--c-muted)}
.v27NMeta .cm{display:inline-flex;align-items:center;gap:4px;color:var(--c-lav);font-weight:700}
.v27NMeta .cm svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linejoin:round}
.v27Badge{display:inline-block;padding:2px 7px;border-radius:999px;background:rgba(255,90,0,.16);color:#ff8a4d;font-size:10px;font-weight:800;letter-spacing:.3px}
.v27Videos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.v27Video{display:grid;gap:6px;align-content:start;color:inherit;text-decoration:none}
.v27Video .t{font-size:12px;font-weight:600;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.v27Video .tag{position:absolute;left:5px;top:5px;padding:2px 6px;border-radius:6px;background:#ff0033;color:#fff;font-size:10px;font-weight:800}
.v27Skel{border-radius:16px;background:linear-gradient(90deg,var(--c-card2),var(--c-card),var(--c-card2));background-size:200% 100%;animation:v27Shimmer 1.4s linear infinite}
@keyframes v27Shimmer{to{background-position:-200% 0}}
.v27Ov{--c-text:#f7f7fb;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.97);display:grid;place-items:center;padding:12px;color:var(--c-text)}
.v27OvBox{width:100%;max-width:520px;display:grid;gap:10px}
.v27OvTop{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:#c5c8d6}
.v27OvTop button{width:38px;height:38px;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:18px;cursor:pointer}
.v27OvBox video{width:100%;max-height:62vh;background:#000;border-radius:12px}
.v27OvInfo{display:grid;gap:3px}
.v27OvInfo b{font-size:17px}
.v27OvInfo span{font-size:13px;color:#c5c8d6}
.v27OvBtns{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:8px}
.v27OvBtns button{height:44px;border:1px solid #3a3e4c;border-radius:12px;background:#171a24;color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
.v27OvBtns button[disabled]{opacity:.35}
.v27OvBtns button.main{background:#ff5a00;border-color:#ff5a00;color:#0d0d0f}
.v27OvErr{font-size:13px;color:#ff8a8a}
html.v27OvOpen,html.v27OvOpen body{overflow:hidden}
.v27NewsPage{--c-card:#10121a;--c-card2:#171a24;--c-line:#282b38;--c-text:#f7f7fb;--c-muted:#9094a8;--c-accent:#ff5a00;--c-lav:#b58aff;--c-live:#ff4d5e;display:grid;gap:14px;color:var(--c-text)}
.v27Article{padding:16px;border:1px solid var(--c-line);border-radius:18px;background:var(--c-card);display:grid;gap:10px}
.v27Article h1{margin:0;font-size:21px;line-height:1.22;font-weight:800}
.v27Article .dt{font-size:12px;color:var(--c-muted)}
.v27Article .body{font-size:15px;line-height:1.55;white-space:pre-wrap}
.v27Article .none{font-size:13px;color:var(--c-muted)}
.v27Src{display:flex;align-items:center;justify-content:center;padding:12px 14px;border:1px solid var(--c-line);border-radius:12px;color:var(--c-lav)!important;text-decoration:none;font-size:14px;font-weight:700}
.v27Comments{display:grid;gap:8px}
.v27Comment{padding:11px 12px;border:1px solid var(--c-line);border-radius:14px;background:var(--c-card)}
.v27CTop{display:flex;align-items:center;gap:8px;min-width:0}
.v27CTop img,.v27CTop i{display:block;width:26px;height:26px;border-radius:50%;object-fit:cover;background:var(--c-card2);flex:0 0 26px}
.v27CTop b{font-size:13px}
.v27CTop small{margin-left:6px;color:var(--c-muted);font-size:11px}
.v27Comment p{margin:6px 0 0;font-size:14px;line-height:1.4;white-space:pre-wrap}
.v27Composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
.v27Composer textarea{min-height:60px;resize:vertical;border:1px solid var(--c-line);border-radius:12px;background:var(--c-card);color:var(--c-text);padding:10px;font:inherit;font-size:14px}
.v27Composer button{border:1px solid #785594;border-radius:12px;background:#2b2036;color:#fff;font:inherit;font-weight:800;padding:0 14px;cursor:pointer}
html.v15Light .v27Composer button{background:#efe6fa;color:#3b1d6e}
.v27Empty{padding:14px;border:1px dashed var(--c-line);border-radius:14px;text-align:center;color:var(--c-muted);font-size:13px}
.v27NCard{display:grid;gap:6px;padding:13px;border:1px solid var(--c-line);border-radius:16px;background:var(--c-card);color:inherit;text-align:left;font:inherit;cursor:pointer;width:100%}
.v27NCard .t{font-size:15px;font-weight:700;line-height:1.3;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.v27NCard .p{font-size:13px;line-height:1.4;color:var(--c-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.v27NList{display:grid;gap:8px}
.v27Star{font-style:normal;font-size:11px;line-height:1;color:var(--c-accent)}
.v27ChipBox{flex:0 0 112px;scroll-snap-align:start;position:relative;display:flex}
.v27ChipBox .v27Chip{flex:1 1 auto;min-width:0}
.v27Vk{position:absolute;right:6px;top:6px;display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:6px;background:#2787f5;color:#fff!important;font-size:10px;font-weight:800;letter-spacing:.3px;text-decoration:none}
.v27Why{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:700;color:var(--c-accent)}
.v27Seg{display:inline-flex;border:1px solid var(--c-line);border-radius:999px;overflow:hidden;background:var(--c-card)}
.v27Seg button{border:0;background:none;color:var(--c-muted);font:inherit;font-size:12px;font-weight:700;padding:5px 11px;cursor:pointer}
.v27Seg button.on{background:var(--c-accent);color:#fff}
.v27Hint{display:flex;align-items:center;gap:6px;margin-top:8px;padding:9px 12px;border:1px dashed var(--c-line);border-radius:12px;font-size:13px;color:var(--c-muted)}
.v27Hint button[data-v27-follow]{flex:1;border:0;background:none;padding:0;text-align:left;font:inherit;font-size:13px;font-weight:600;color:var(--c-lav);cursor:pointer}
.v27Hint button[data-v27-hint-close]{border:0;background:none;color:var(--c-muted);font-size:18px;line-height:1;padding:0 4px;cursor:pointer}
.v27Rus{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x proximity;margin:0 -2px;padding:2px 2px 4px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.v27Rus::-webkit-scrollbar{display:none}
.v27Ru{flex:0 0 84px;scroll-snap-align:start;display:grid;gap:3px;justify-items:center;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-align:center}
.v27Ru .ph{position:relative;display:grid;place-items:center;width:62px;height:62px;border-radius:50%;background:radial-gradient(circle at 50% 35%,#2b3040,#12141c 80%);border:2px solid var(--c-line);overflow:hidden}
.v27Ru.mine .ph{border-color:var(--c-accent)}
.v27Ru .ph img{position:absolute;left:0;bottom:0;width:100%;height:100%;object-fit:cover;object-position:top}
.v27Ru .ph i{font-style:normal;font-size:20px;font-weight:800;color:#c5c8d6}
.v27Ru .ph em{position:absolute;right:3px;top:3px;width:9px;height:9px;border-radius:50%;background:var(--c-live);border:2px solid var(--c-card)}
.v27Ru b{font-size:13px;font-weight:800;line-height:1.15;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v27Ru .st{font-size:13px;font-weight:700;min-height:16px}
.v27Ru small{font-size:11px;color:var(--c-muted);font-weight:600}
.v27Mine{color:var(--c-accent);font-weight:800}
.v27Cnt{color:var(--c-muted);font-weight:600;font-size:12px}
.v27HeroTeams .rec{display:block;margin-top:2px;font-size:12px;font-weight:600;color:var(--c-muted)}
.v27Settings{--c-card:#10121a;--c-line:#282b38;--c-text:#f7f7fb;--c-muted:#9094a8;--c-accent:#ff5a00;display:grid;gap:10px;margin:0 0 12px;padding:14px;border:1px solid var(--c-line);border-radius:16px;background:var(--c-card);color:var(--c-text)}
html.v15Light .v27Settings{--c-card:#ffffff;--c-line:#e2e4ec;--c-text:#0c0d14;--c-muted:#686c7e}
.v27SetTitle{font-size:15px;font-weight:800}
.v27SetNote{margin:0;font-size:12px;color:var(--c-muted);line-height:1.4}
.v27SetRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:10px;border-top:1px solid var(--c-line)}
.v27SetRow b{display:block;font-size:14px}
.v27SetRow span{display:block;font-size:12px;color:var(--c-muted);line-height:1.35;margin-top:2px}
.v27Sw{flex:0 0 48px;height:28px;border-radius:999px;border:1px solid var(--c-line);background:var(--c-line);position:relative;cursor:pointer;padding:0}
.v27Sw i{position:absolute;left:2px;top:2px;width:22px;height:22px;border-radius:50%;background:#fff;transition:left .15s}
.v27Sw.on{background:var(--c-accent);border-color:var(--c-accent)}
.v27Sw.on i{left:22px}
`;
    document.head.appendChild(style);
  }

  // ---- renderers -------------------------------------------------------------------------------------------------------------
  function chipHtml(g, hide, why) {
    const live = g.phase === "live";
    const done = g.phase === "final";
    const away = g.away || {};
    const homeTeam = g.home || {};
    const status = live
      ? '<span class="v27Live"><i></i>LIVE</span>'
      : done
        ? `Финал${g.finish === "OT" ? " · ОТ" : g.finish === "SO" ? " · Б" : ""}`
        : esc(clock(g.start));
    const mid = live || done
      ? `<b>${hide ? `•${colon}•` : `${n0(g.away_score)}${colon}${n0(g.home_score)}`}</b>`
      : '<b class="dash">—</b>';
    const label = `${away.name_ru || away.tri || ""} — ${homeTeam.name_ru || homeTeam.tri || ""}`;
    const vkUrl = webUrl(g.vk_url);
    const vk = vkUrl ? `<a class="v27Vk" href="${esc(vkUrl)}" target="_blank" rel="noopener" aria-label="${live ? "Смотреть в VK" : done ? "Запись в VK" : "Трансляция в VK"}">VK</a>` : "";
    const reason = why ? `<span class="v27Why"><i class="v27Star" aria-hidden="true">★</i> ${esc(why)}</span>` : "";
    return `<div class="v27ChipBox"><button type="button" class="v27Chip ${live ? "live" : done ? "done" : "up"}${why ? " mine" : ""}" data-v27-game="${esc(g.game_pk)}" aria-label="${esc(label)}${why ? ` (${esc(why)})` : ""}"><span class="v27ChipTop">${status}</span><span class="v27ChipMid"><img src="${esc(away.logo || "")}" alt="">${mid}<img src="${esc(homeTeam.logo || "")}" alt=""></span><span class="v27ChipTri">${esc(away.tri || "")} · ${esc(homeTeam.tri || "")}</span>${reason}</button>${vk}</div>`;
  }

  function stripHtml(d) {
    const games = d.games || [];
    if (!games.length) return "";
    const hide = noSpoilers();
    const today = localToday();
    const day = d.strip_day === today ? "сегодня" : shortDate(d.strip_day);
    const caption = d.mode === "results" ? `Итоги · ${day}` : `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${games.length} ${plural(games.length, "матч", "матча", "матчей")}`;
    // my games come right after the ones that are on; with "Мои" only they are alone
    let list = games.map((g) => ({ g, why: mineReason(g) }));
    const mineCount = list.filter((x) => x.why).length;
    const onlyMine = st.mineOnly && mineCount > 0;
    list.sort((a, b) => (a.g.phase === "live" ? 0 : 1) * 2 + (a.why ? 0 : 1) - ((b.g.phase === "live" ? 0 : 1) * 2 + (b.why ? 0 : 1)));
    if (onlyMine) list = list.filter((x) => x.why);
    const right = mineCount > 0
      ? `<span class="v27Seg"><button type="button" data-v27-seg="all"${onlyMine ? "" : ' class="on"'}>Все</button><button type="button" data-v27-seg="mine"${onlyMine ? ' class="on"' : ""}>★ Мои</button></span>`
      : '<button type="button" data-v27-all="1">Все матчи ›</button>';
    const hint = mineOn() && st.follows && st.follows.ok && !followed() && !st.hintHidden
      ? '<div class="v27Hint"><button type="button" data-v27-follow="1">☆ Выберите любимые команды: их матчи будут первыми</button><button type="button" data-v27-hint-close="1" aria-label="Скрыть">×</button></div>'
      : "";
    return `<div class="v27Head"><b>${esc(caption)}</b>${right}</div><div class="v27Strip">${list.map((x) => chipHtml(x.g, hide, x.why)).join("")}<button type="button" class="v27ChipMore" data-v27-all="1">Все матчи</button></div>${hint}`;
  }

  function russiansTitle(d) {
    if (d.mode === "live") return "Русские в игре";
    if (d.mode === "results") return "Русские: как сыграли";
    return d.russians.day === localToday() ? "Русские сегодня" : `Русские · ${shortDate(d.russians.day)}`;
  }

  function russianHtml(p, hide, mine) {
    const name = p.name_ru || p.name_en || "Игрок";
    const played = p.phase === "live" || p.phase === "final";
    let stat = "";
    if (!played) stat = clock(p.start);
    else if (p.line && !hide) stat = p.line.kind === "g" ? `${p.line.saves} из ${p.line.shots}` : `${p.line.goals}+${p.line.assists}`;
    else stat = hide ? "•" : "";
    const photo = p.photo ? `<img loading="lazy" decoding="async" src="${esc(p.photo)}" alt="">` : "";
    const initial = surname(name).charAt(0);
    return `<button type="button" class="v27Ru${mine ? " mine" : ""}" data-v27-ru="${esc(p.player_id)}"><span class="ph"><i>${esc(initial)}</i>${photo}${p.phase === "live" ? "<em></em>" : ""}</span><b>${mine ? "★ " : ""}${esc(surname(name))}</b><span class="st">${esc(stat)}</span><small>${esc(p.team)} ${p.home ? "vs" : "@"} ${esc(p.opp)}</small></button>`;
  }

  function russiansHtml(d) {
    const r = d.russians;
    if (!st.prefs.russians || !r || !r.ok || !r.items || !r.items.length) return "";
    const hide = noSpoilers();
    const mineIds = myPlayers();
    const items = r.items.map((p) => ({ p, mine: mineIds.has(p.player_id) }));
    items.sort((a, b) => Number(b.mine) - Number(a.mine));
    const hasStats = !hide && r.items.some((p) => p.line);
    return `<div class="v27Head"><b>${esc(russiansTitle(d))}</b>${hasStats ? "<small>голы + передачи</small>" : ""}</div><div class="v27Rus v27Shelf">${items.map((x) => russianHtml(x.p, hide, x.mine)).join("")}</div>`;
  }

  function oddHtml(label, value, gamePk) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 1) return "";
    return `<a class="v27Odd" href="/go/winline?game_pk=${encodeURIComponent(gamePk)}" target="_blank" rel="noopener"><span>${label}</span><b>${n.toFixed(2)}</b></a>`;
  }

  function winlineHtml(g) {
    const w = g.winline;
    if (!w) return "";
    const odds = [oddHtml("П1", w.p1, g.game_pk), oddHtml("Н", w.x, g.game_pk), oddHtml("П2", w.p2, g.game_pk)].filter(Boolean);
    return odds.length ? `<div class="v27Wl"><img src="/broadcast/winline-logo.png?asset=canonical-3" alt="WINLINE">${odds.join("")}</div>` : "";
  }

  const recordHtml = (r) => (r ? `<span class="rec" title="победы – поражения – поражения в ОТ/Б">(${n0(r.w)}–${n0(r.l)}–${n0(r.otl)})</span>` : "");

  function heroHtml(g) {
    if (!g) return "";
    const away = g.away || {};
    const homeTeam = g.home || {};
    const awayName = away.name_ru || away.name_en || away.tri || "Гости";
    const homeName = homeTeam.name_ru || homeTeam.name_en || homeTeam.tri || "Хозяева";
    const code = String(g.game_state || "").toUpperCase();
    const live = code === "LIVE" || code === "CRIT";
    const done = code === "OFF" || code === "FINAL";
    const hide = noSpoilers();
    const score = hide ? `•${colon}•` : `${n0(g.away_score)}${colon}${n0(g.home_score)}`;
    // the record moves with the result of a game that is on or finished: hidden in no-spoilers mode
    const showRecords = !(hide && (live || done));
    const cover = coverSrc(g);
    const badge = '<span class="v27LiveBadge"><i></i>LIVE</span>';
    const finish = done ? (g.period_type === "OT" ? " · ОТ" : g.period_type === "SO" ? " · Б" : "") : "";
    const mid = live
      ? `<div class="v27HeroMid"><strong>${score}</strong>${g.live_label && !hide ? `<small>${esc(g.live_label)}</small>` : ""}</div>`
      : done
        ? `<div class="v27HeroMid"><strong>${score}</strong><small>ФИНАЛ${finish}</small></div>`
        : `<div class="v27HeroMid"><strong>${esc(clock(g.scheduled_start_utc))}</strong><small>${esc(whenWord(g.scheduled_start_utc))}</small></div>`;
    const kickerRight = live ? (cover ? "" : badge) : done ? "Матч завершён" : "";
    const vkText = live ? "Смотреть матч в VK Видео" : done ? "Смотреть запись в VK Видео" : "Трансляция в VK Видео";
    const vk = esc(g.vk_url || "https://vkvideo.ru/@nhl_home_of_hockey/lives");
    return `<article class="v27Hero" data-game="${esc(g.game_pk)}">${cover ? `<div class="v27HeroCover"><img src="${esc(cover)}" alt="${esc(`${awayName} — ${homeName}`)}">${live ? badge : ""}</div>` : ""}<div class="v27HeroBody"><div class="v27Kicker">Матч дня${kickerRight ? `<span>${kickerRight}</span>` : ""}</div><div class="v27HeroTeams"><div><img src="${esc(away.logo || "")}" alt=""><span class="nm">${esc(awayName)}</span>${showRecords ? recordHtml(g.away_record) : ""}</div>${mid}<div><img src="${esc(homeTeam.logo || "")}" alt=""><span class="nm">${esc(homeName)}</span>${showRecords ? recordHtml(g.home_record) : ""}</div></div>${winlineHtml(g)}<a class="v27Cta" href="${vk}" target="_blank" rel="noopener"><span>${vkText}</span><span>→</span></a></div></article>`;
  }

  function goalsTitle(gl, today) {
    if (gl.live) return "Голы в эфире";
    if (gl.day === today) return "Голы сегодня";
    if (gl.day === prevDay(today)) return "Голы вчера";
    return `Голы · ${shortDate(gl.day)}`;
  }

  function tileHtml(t, i, mine) {
    const name = t.scorer_ru || t.scorer_en || "Гол";
    const logo = t.team && t.home && t.team === t.home.tri ? t.home.logo : t.away && t.away.logo;
    const poster = t.poster_url
      ? `<img class="cover" loading="lazy" decoding="async" src="${esc(t.poster_url)}" alt="">`
      : `<span class="logos"><img src="${esc(t.away && t.away.logo)}" alt=""><img src="${esc(t.home && t.home.logo)}" alt=""></span>`;
    const dur = duration(t.duration);
    return `<button type="button" class="v27Goal" data-v27-goal="${i}" aria-label="Смотреть гол: ${esc(name)}"><span class="v27Poster">${poster}<span class="play">${PLAY_SVG}</span>${dur ? `<em>${dur}</em>` : ""}</span><span class="nm">${mine ? '<span class="v27Mine">★</span> ' : ""}${esc(surname(name))}${t.season_goal ? ` <span class="v27Cnt">(${t.season_goal}-я)</span>` : ""}</span><span class="sc"><img src="${esc(logo || "")}" alt="">${esc(t.away && t.away.tri)} ${n0(t.away_score)}:${n0(t.home_score)} ${esc(t.home && t.home.tri)}</span><span class="tm">${esc(t.period_short)}${t.time ? ` · ${esc(t.time)}` : ""}</span></button>`;
  }

  function goalsHtml(d) {
    const gl = d.goals;
    if (!gl || !gl.ok || !gl.items || !gl.items.length) return "";
    const title = goalsTitle(gl, localToday());
    const count = `${gl.total} ${plural(gl.total, "ролик", "ролика", "роликов")}`;
    if (noSpoilers() && !st.revealed) {
      return `<div class="v27Head"><b>${esc(title)}</b></div><div class="v27Note">Включён режим «без спойлеров»: голы и счёт скрыты.<button type="button" data-v27-reveal="1">Показать голы</button></div>`;
    }
    const teams = myTeams();
    const players = myPlayers();
    const mineTile = (t) => teams.has(String(t.team || "").toUpperCase()) || players.has(t.scorer_id);
    return `<div class="v27Head"><b>${esc(title)}</b><small>${esc(count)}</small></div><div class="v27Shelf">${gl.items.map((t, i) => tileHtml(t, i, mineTile(t))).join("")}</div>`;
  }

  function newsMetaHtml(x, mine) {
    const c = Number(x.comment_count || 0);
    const badge = x.source_badge ? `<span class="v27Badge">${esc(x.source_badge)}</span>` : "";
    return `<span class="v27NMeta">${mine ? '<span class="v27Mine">★ ваша команда</span>' : ""}${badge}<span>${esc(ago(x.published_at || x.created_at))}</span>${c > 0 ? `<span class="cm">${CHAT_SVG}${c}</span>` : ""}</span>`;
  }

  function newsRowHtml(x, mine) {
    return `<button type="button" class="v27News" data-v27-news="${esc(x.news_id)}"><span class="v27NTitle">${esc(x.title)}</span>${newsMetaHtml(x, mine)}</button>`;
  }

  // the three news of the home page: those about my teams and players first, the newest ones fill the rest
  function homeNews() {
    const flagged = (st.news || []).map((x) => ({ x, mine: newsIsMine(x) }));
    return [...flagged.filter((f) => f.mine), ...flagged.filter((f) => !f.mine)].slice(0, HOME_NEWS_COUNT);
  }

  function newsHtml() {
    const list = homeNews();
    if (!list.length) return "";
    return `<div class="v27Head"><b>Свежее в НХЛ</b><button type="button" data-v27-news-all="1">Все новости ›</button></div><div class="v27NewsList">${list.map((f) => newsRowHtml(f.x, f.mine)).join("")}</div>`;
  }

  const ruTitle = (title, kind) => {
    const t = String(title || "").replace(/#[A-Za-z0-9_А-Яа-яЁё]+/g, "").trim();
    return /[А-Яа-яЁё]/.test(t) ? t : kind === "news" ? "Свежий выпуск новостей НХЛ" : "Короткое видео Home of Hockey";
  };

  function videosHtml() {
    const items = st.media || [];
    const news = items.find((x) => x.kind === "news");
    const shorts = items.filter((x) => x.kind === "short").slice(0, news ? 2 : 3);
    const picks = [...(news ? [news] : []), ...shorts];
    if (!picks.length) return "";
    const tile = (x) => `<a class="v27Video" href="${esc(x.url)}" target="_blank" rel="noopener"><span class="v27Poster">${x.thumb ? `<img class="cover" loading="lazy" decoding="async" src="${esc(x.thumb)}" alt="">` : ""}<span class="play">${PLAY_SVG}</span>${x.kind === "news" ? '<span class="tag">ВЫПУСК</span>' : ""}</span><span class="t">${esc(ruTitle(x.title, x.kind))}</span></a>`;
    return `<div class="v27Head"><b>Видео Home of Hockey</b><small>YouTube</small></div><div class="v27Videos">${picks.map(tile).join("")}</div>`;
  }

  // ---- painting --------------------------------------------------------------------------------------------------------------
  const SECTIONS = ["strip", "hero", "goals", "russians", "news", "videos"];
  function build() {
    const el = document.createElement("section");
    el.className = "v27Home";
    el.innerHTML = SECTIONS.map((s, i) => `<div class="v27Sec" data-sec="${s}" style="order:${i + 1}" hidden></div>`).join("");
    el.addEventListener("click", onHomeClick);
    return el;
  }

  function setSec(name, html, order) {
    const el = home();
    const box = el && el.querySelector(`[data-sec="${name}"]`);
    if (!box) return;
    if (order != null) box.style.order = String(order);
    if (st.sections[name] === html) return;
    const scroller = box.querySelector(".v27Strip,.v27Shelf");
    const left = scroller ? scroller.scrollLeft : 0;
    box.innerHTML = html;
    box.hidden = !html;
    st.sections[name] = html;
    if (left) {
      const again = box.querySelector(".v27Strip,.v27Shelf");
      if (again) again.scrollLeft = left;
    }
  }

  const SKEL_STRIP = '<div class="v27Strip">' + '<div class="v27Skel" style="flex:0 0 112px;height:84px"></div>'.repeat(3) + "</div>";
  const SKEL_HERO = '<div class="v27Skel" style="height:300px"></div>';

  function paintHome() {
    const d = st.data;
    if (!d) {
      setSec("strip", SKEL_STRIP, 1);
      setSec("hero", SKEL_HERO, 2);
      return;
    }
    const results = d.mode === "results";
    setSec("strip", stripHtml(d), 1);
    setSec("russians", russiansHtml(d), 2);
    setSec("hero", d.featured ? heroHtml(d.featured) : "", results ? 4 : 3);
    setSec("goals", goalsHtml(d), results ? 3 : 4);
  }
  const paintNews = () => setSec("news", newsHtml(), 5);
  const paintVideos = () => setSec("videos", videosHtml(), 6);
  function paintAll() {
    paintHome();
    paintNews();
    paintVideos();
  }
  // the follows arrived or changed: everything that depends on "my" is drawn again
  function paintPersonal() {
    if (!home()) return;
    paintHome();
    paintNews();
  }

  // ---- loading ---------------------------------------------------------------------------------------------------------------
  async function loadHome() {
    const d = await H.api(`${API}/home?v=${Date.now()}`);
    if (!d || d.ok === false || !Array.isArray(d.games)) throw new Error("home_unavailable");
    st.data = d;
    st.fails = 0;
    st.lastAt = Date.now();
  }
  async function loadNews(force) {
    if (!force && st.news && Date.now() - st.newsAt < NEWS_TTL_MS) return;
    const d = await H.api(`${NEWS_API}/news/home?limit=20&v=${Math.floor(Date.now() / NEWS_TTL_MS)}`);
    if (d && Array.isArray(d.news) && d.news.length) {
      st.news = d.news;
      st.newsAt = Date.now();
    }
  }
  async function loadMedia() {
    if (st.media && Date.now() - st.mediaAt < MEDIA_TTL_MS) return;
    const d = await H.api(`${MEDIA_API}/media?v27=${Math.floor(Date.now() / 60000)}`);
    if (d && Array.isArray(d.items)) {
      st.media = d.items;
      st.mediaAt = Date.now();
    }
  }

  function giveUp() {
    S.failed = true;
    clearTimeout(st.timer);
    st.timer = null;
    const el = home();
    if (el) el.remove();
    if (typeof H.runCore === "function") setTimeout(() => H.runCore(), 0);
  }

  // The follows of the person (teams and players). Not inside Telegram: an empty answer, nothing personal on the page.
  async function loadFollows(force, homeDone) {
    if (!force && st.follows && Date.now() - st.followsAt < FOLLOWS_TTL_MS) return;
    st.followsAt = Date.now();
    const next = { ok: false, teams: new Set(), teamNames: new Map(), players: new Map() };
    try {
      const d = await H.api(`${H.V2 || "/api/telegram-center-v2"}/subscriptions`);
      if (d && d.ok !== false && Array.isArray(d.subscriptions)) {
        next.ok = true;
        for (const s of d.subscriptions) {
          if (s.subject_type === "team") {
            const tri = String(s.subject_key || "").toUpperCase();
            next.teams.add(tri);
            next.teamNames.set(tri, String(s.name || ""));
          } else if (s.subject_type === "player") {
            const id = Number(s.subject_key);
            if (id) next.players.set(id, String(s.name || ""));
            if (id && s.current_team_tri) st.playerTeams.set(id, String(s.current_team_tri).toUpperCase());
          }
        }
      }
    } catch (e) { /* no personal part */ }
    st.follows = next;
    paintPersonal(); // the teams are known: stars at once
    // the team of a followed player that is not in the Russians list: asked once, remembered
    if (homeDone) await homeDone; // the Russians list answers most of the questions
    const ids =[...next.players.keys()].filter((id) => !playerTeam(id)).slice(0, MAX_PLAYER_LOOKUPS);
    await Promise.allSettled(ids.map(async (id) => {
      const d = await H.api(`/api/telegram-center-v17/players/${id}`);
      const tri = d && d.player && d.player.current_team_tri;
      if (tri) st.playerTeams.set(id, String(tri).toUpperCase());
    }));
  }

  async function refresh() {
    if (st.busy || S.failed) return;
    st.busy = true;
    try {
      const homeDone = loadHome().then(paintHome, () => {
        st.fails += 1;
        if (!st.data && st.fails >= 2) giveUp();
      });
      await Promise.allSettled([
        homeDone,
        loadNews().then(paintNews, () => {}),
        loadMedia().then(paintVideos, () => {}),
        (mineOn() ? loadFollows(false, homeDone) : Promise.resolve()).then(paintPersonal, () => {}),
      ]);
    } finally {
      st.busy = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(st.timer);
    st.timer = null;
    if (S.failed || !home()) return;
    const live = st.data && st.data.mode === "live";
    st.timer = setTimeout(() => {
      st.timer = null;
      if (document.visibilityState === "hidden") schedule();
      else refresh();
    }, live ? POLL_LIVE_MS : POLL_IDLE_MS);
  }

  function mount() {
    if (S.failed) return;
    const root = H.view();
    if (!root) return;
    mountSettings();
    const existing = home();
    if (!homeAllowed()) {
      if (existing) existing.remove();
      clearTimeout(st.timer);
      st.timer = null;
      return;
    }
    root.querySelectorAll(":scope > .v15Media, :scope > .v20News, :scope > .v25FeaturedGame, :scope > .mediaShelf, :scope > .v12Media").forEach((x) => x.remove());
    if (!existing) {
      root.prepend(build());
      st.sections = {};
      paintAll();
    }
    if (!st.timer && !st.busy && (!st.data || Date.now() - st.lastAt > 5000)) refresh();
  }

  // ---- settings: the home page of the person -----------------------------------------------------------------------------------
  function settingsHtml() {
    const row = (key, title, note) => `<div class="v27SetRow"><div><b>${title}</b><span>${note}</span></div><button type="button" class="v27Sw${st.prefs[key] ? " on" : ""}" role="switch" aria-checked="${st.prefs[key] ? "true" : "false"}" aria-label="${title}" data-v27-pref="${key}"><i></i></button></div>`;
    return `<b class="v27SetTitle">Главная страница</b><p class="v27SetNote">Настройте главную под себя. Включить и выключить можно в любой момент.</p>${row("russians", "Русские в НХЛ", "Блок с российскими игроками дня и их результатами, сразу под списком матчей.")}${row("mine", "Моя лента", "Звёздочка у моих команд и игроков, переключатель «Мои» в списке матчей, новости про мои команды. Нужны подписки на команды или игроков.")}`;
  }

  function onSettingsClick(e) {
    const sw = e.target.closest && e.target.closest("[data-v27-pref]");
    if (!sw) return;
    const key = sw.dataset.v27Pref;
    if (!(key in PREF_STORE)) return;
    st.prefs[key] = !st.prefs[key];
    store.set(PREF_STORE[key], st.prefs[key] ? "1" : "0");
    sw.classList.toggle("on", st.prefs[key]);
    sw.setAttribute("aria-checked", st.prefs[key] ? "true" : "false");
    st.sections = {};
    // "my feed" has just been switched on: the follows are fetched now, so the stars are there when the person is back on the home page
    if (key === "mine" && st.prefs.mine) loadFollows(true).catch(() => {});
  }

  // the card sits under the theme switch of the "Мои" screen
  function mountSettings() {
    const root = H.view();
    if (!root) return;
    const tab = H.currentTab();
    const here = !H.state.profile && (tab === "follows" || tab === "mine") && H.tabsVisible();
    const card = root.querySelector(":scope > .v27Settings");
    if (!here) {
      if (card) card.remove();
      return;
    }
    if (card) return;
    const el = document.createElement("section");
    el.className = "v27Settings";
    el.innerHTML = settingsHtml();
    el.addEventListener("click", onSettingsClick);
    const theme = root.querySelector(":scope > #v15Theme");
    if (theme) theme.after(el);
    else root.prepend(el);
  }

  // ---- goal player -----------------------------------------------------------------------------------------------------------
  function closeGoal() {
    const ov = document.getElementById("v27Ov");
    if (ov) {
      const v = ov.querySelector("video");
      if (v) {
        try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) { /* ignore */ }
      }
      ov.remove();
    }
    document.documentElement.classList.remove("v27OvOpen");
    st.goalIndex = -1;
  }

  function overlayHtml(t, i, total) {
    const name = t.scorer_ru || t.scorer_en || "Гол";
    const score = `${t.away && t.away.tri} ${n0(t.away_score)}:${n0(t.home_score)} ${t.home && t.home.tri}`;
    return `<div class="v27OvBox"><div class="v27OvTop"><span>Гол ${i + 1} из ${total}</span><button type="button" data-v27-ov="close" aria-label="Закрыть">✕</button></div><video controls playsinline webkit-playsinline preload="metadata"${t.poster_url ? ` poster="${esc(t.poster_url)}"` : ""} src="${esc(t.clip_url)}"></video><div class="v27OvErr" hidden></div><div class="v27OvInfo"><b>${esc(name)}</b><span>${esc(score)} · ${esc(t.period_short)}${t.time ? ` ${esc(t.time)}` : ""}${t.season_goal ? ` · ${t.season_goal}-я шайба в сезоне` : ""}</span></div><div class="v27OvBtns"><button type="button" data-v27-ov="prev"${i <= 0 ? " disabled" : ""}>‹ Назад</button><button type="button" class="main" data-v27-ov="match">К матчу</button><button type="button" data-v27-ov="next"${i >= total - 1 ? " disabled" : ""}>Дальше ›</button></div></div>`;
  }

  function showGoal(i) {
    const t = st.queue[i];
    if (!t) return;
    st.goalIndex = i;
    let ov = document.getElementById("v27Ov");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "v27Ov";
      ov.className = "v27Ov";
      ov.addEventListener("click", onOverlayClick);
      document.body.appendChild(ov);
    }
    document.documentElement.classList.add("v27OvOpen");
    ov.innerHTML = overlayHtml(t, i, st.queue.length);
    const video = ov.querySelector("video");
    video.addEventListener("ended", () => {
      if (st.goalIndex < st.queue.length - 1) showGoal(st.goalIndex + 1);
    });
    video.addEventListener("error", () => {
      const err = ov.querySelector(".v27OvErr");
      if (err) { err.hidden = false; err.textContent = "Не удалось загрузить видео. Проверьте соединение."; }
    });
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* the viewer can press play */ });
  }

  function onOverlayClick(e) {
    const btn = e.target.closest && e.target.closest("[data-v27-ov]");
    if (!btn) {
      if (e.target.id === "v27Ov") closeGoal();
      return;
    }
    const action = btn.dataset.v27Ov;
    if (action === "close") closeGoal();
    else if (action === "prev" && st.goalIndex > 0) showGoal(st.goalIndex - 1);
    else if (action === "next" && st.goalIndex < st.queue.length - 1) showGoal(st.goalIndex + 1);
    else if (action === "match") {
      const t = st.queue[st.goalIndex];
      closeGoal();
      if (t) openGame(t.game_pk);
    }
  }

  function openGame(pk) {
    const id = Number(pk);
    if (id && typeof H.openGameV19 === "function") H.openGameV19(id, { returnTab: "games" });
  }

  function onHomeClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const chip = t.closest("[data-v27-game]");
    if (chip) return openGame(chip.dataset.v27Game);
    const goal = t.closest("[data-v27-goal]");
    if (goal) {
      st.queue = ((st.data && st.data.goals && st.data.goals.items) || []).slice();
      return showGoal(Number(goal.dataset.v27Goal));
    }
    if (t.closest("[data-v27-all]")) {
      const tab = document.querySelector('.tab[data-tab="broadcasts"]');
      if (tab) tab.click();
      return;
    }
    if (t.closest("[data-v27-reveal]")) {
      st.revealed = true;
      return paintHome();
    }
    const seg = t.closest("[data-v27-seg]");
    if (seg) {
      st.mineOnly = seg.dataset.v27Seg === "mine";
      store.set("hoh-home-mine", st.mineOnly ? "1" : "0");
      return paintHome();
    }
    if (t.closest("[data-v27-follow]")) {
      const tab = document.querySelector('.tab[data-tab="teams"]');
      if (tab) tab.click();
      return;
    }
    if (t.closest("[data-v27-hint-close]")) {
      st.hintHidden = true;
      store.set("hoh-home-hint", "1");
      return paintHome();
    }
    const ru = t.closest("[data-v27-ru]");
    if (ru) {
      const id = Number(ru.dataset.v27Ru);
      if (id && typeof H.openPlayer === "function") H.openPlayer(id);
      return;
    }
    const news = t.closest("[data-v27-news]");
    if (news) return openNews(Number(news.dataset.v27News));
    if (t.closest("[data-v27-news-all]")) return openNews(null);
    const hero = t.closest(".v27Hero");
    if (hero && !t.closest("a")) openGame(hero.dataset.game);
  }

  // ---- news page -------------------------------------------------------------------------------------------------------------
  function leaveNews() {
    st.openNewsId = null;
    H.state.profile = false;
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.style.display = "grid";
    const tab = document.querySelector('.tab[data-tab="games"]');
    if (tab) tab.click();
  }

  function articleHtml(n) {
    const badge = n.source_badge ? `<span class="v27Badge">${esc(n.source_badge)}</span>` : "";
    const source = webUrl(n.source_url);
    const body = n.body_text
      ? `<div class="body">${esc(n.body_text)}</div>`
      : `<div class="none">${source ? "Полный текст — на сайте источника." : "Полный текст пока не подгрузился."} Можно обсудить новость в комментариях.</div>`;
    const link = source ? `<a class="v27Src" href="${esc(source)}" target="_blank" rel="noopener">Читать на ${esc(hostOf(source))} ›</a>` : "";
    return `<article class="v27Article">${badge}<h1>${esc(n.title || "Новость НХЛ")}</h1><div class="dt">${esc(fullDate(n.published_at || n.created_at))}</div>${body}${link}</article><div class="v27Head"><b>Комментарии</b><small id="v27CCount">${Number(n.comment_count || 0)}</small></div><div class="v27Comments" id="v27Comments"><div class="v27Empty">Загрузка комментариев…</div></div><div class="v27Composer"><textarea id="v27CText" maxlength="1000" placeholder="Написать комментарий…"></textarea><button type="button" id="v27CSend">Отправить</button></div>`;
  }

  function cardHtml(x) {
    const preview = x.body_text ? `<span class="p">${esc(String(x.body_text).replace(/\s+/g, " ").slice(0, 200))}</span>` : "";
    return `<button type="button" class="v27NCard" data-v27-open="${esc(x.news_id)}"><span class="t">${esc(x.title)}</span>${preview}${newsMetaHtml(x, newsIsMine(x))}</button>`;
  }

  function paintNewsList() {
    const box = document.getElementById("v27NList");
    if (!box) return;
    const rest = (st.news || []).filter((x) => Number(x.news_id) !== Number(st.openNewsId));
    const title = st.openNewsId ? "Другие новости" : "Свежее в НХЛ";
    box.innerHTML = rest.length
      ? `<div class="v27Head"><b>${title}</b><small>${rest.length}</small></div><div class="v27NList">${rest.map(cardHtml).join("")}</div>`
      : '<div class="v27Empty">Новостей пока нет.</div>';
  }

  function renderComments(items) {
    const box = document.getElementById("v27Comments");
    if (!box) return;
    box.innerHTML = items.length
      ? items.map((x) => `<div class="v27Comment"><div class="v27CTop">${x.avatar_url ? `<img src="${esc(x.avatar_url)}" alt="">` : "<i></i>"}<div><b>${esc(x.author || "Пользователь")}</b><small>${esc(ago(x.created_at))}</small></div></div><p>${esc(x.body)}</p></div>`).join("")
      : '<div class="v27Empty">Пока никто не комментировал. Напишите первым.</div>';
    const c = document.getElementById("v27CCount");
    if (c) c.textContent = String(items.length);
    const known = (st.news || []).find((x) => Number(x.news_id) === Number(st.openNewsId));
    if (known) known.comment_count = items.length;
  }

  async function loadComments(id) {
    try {
      const d = await H.api(`${NEWS_API}/news/${id}/comments`);
      if (Number(st.openNewsId) === Number(id)) renderComments(d.comments || []);
    } catch (e) {
      const box = document.getElementById("v27Comments");
      if (box && Number(st.openNewsId) === Number(id)) box.innerHTML = '<div class="v27Empty">Комментарии не загрузились. Вернитесь назад и откройте новость снова.</div>';
    }
  }

  async function sendComment(id) {
    const ta = document.getElementById("v27CText");
    const btn = document.getElementById("v27CSend");
    const body = String((ta && ta.value) || "").trim();
    if (!body) return;
    if (window.HOHEnsureCommentIdentity && !(await window.HOHEnsureCommentIdentity())) return;
    if (btn) btn.disabled = true;
    try {
      await H.api(`${NEWS_API}/news/${id}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      if (ta) ta.value = "";
      await loadComments(id);
    } catch (e) {
      alert((e && e.message) || e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function articleOf(id) {
    const known = (st.news || []).find((x) => Number(x.news_id) === Number(id));
    if (known) return known;
    const d = await H.api(`${NEWS_API}/news/${id}`);
    return d.news || null;
  }

  async function openNews(id) {
    const root = H.view();
    if (!root) return;
    closeGoal();
    st.openNewsId = id ? Number(id) : null;
    H.state.profile = true;
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.style.display = "none";
    // v20Detail: the layer that puts the eye and the gear into the back row recognizes the page by this class
    root.innerHTML = `<div class="v27NewsPage v20Detail">${H.backRow("Новости")}<div id="v27NArt"></div><div id="v27NList"></div></div>`;
    const back = document.getElementById("v15Back");
    if (back) back.onclick = leaveNews;
    paintNewsList();
    window.scrollTo(0, 0);
    if (!st.news || Date.now() - st.newsAt > NEWS_TTL_MS) loadNews(true).then(paintNewsList, () => {});
    if (!id) return;
    const slot = document.getElementById("v27NArt");
    if (slot) slot.innerHTML = '<div class="v27Skel" style="height:220px"></div>';
    try {
      const article = await articleOf(id);
      if (Number(st.openNewsId) !== Number(id)) return;
      if (!article) throw new Error("not_found");
      document.getElementById("v27NArt").innerHTML = articleHtml(article);
      const send = document.getElementById("v27CSend");
      if (send) send.onclick = () => sendComment(id);
      paintNewsList();
      loadComments(id);
    } catch (e) {
      const art = document.getElementById("v27NArt");
      if (art) art.innerHTML = '<div class="v27Empty">Не удалось загрузить новость. Вернитесь назад и откройте её снова.</div>';
    }
  }

  document.addEventListener("click", (e) => {
    const card = e.target.closest && e.target.closest("[data-v27-open]");
    if (card && document.querySelector(".v27NewsPage")) openNews(Number(card.dataset.v27Open));
  });

  // ---- wiring ----------------------------------------------------------------------------------------------------------------
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.closest) return;
    const src = img.getAttribute("src") || "";
    if (img.closest(".v27HeroCover")) {
      failures().add(src);
      st.sections.hero = null;
      paintHome();
    } else if (img.closest(".v27Poster") && img.classList.contains("cover")) {
      img.remove();
    } else if (img.closest(".v27Ru")) {
      img.remove(); // the initial letter underneath stays
    }
  }, true);

  window.addEventListener("hoh-spoilers-change", () => {
    st.revealed = false;
    if (home()) paintHome();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && home() && !st.busy && Date.now() - st.lastAt > 10000) refresh();
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".tab")) setTimeout(mount, 120);
  }, true);

  const oldRun = H.runCore;
  H.runCore = function () {
    const result = typeof oldRun === "function" ? oldRun.apply(this, arguments) : undefined;
    setTimeout(mount, 40);
    return result;
  };

  S.mount = mount;
  S.refresh = refresh;
  S.openNews = openNews;
  S.paintAll = paintAll;
  css();
  setTimeout(mount, 100);
  setTimeout(mount, 600);
}
