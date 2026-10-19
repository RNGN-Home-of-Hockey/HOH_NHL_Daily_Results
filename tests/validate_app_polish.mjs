// Live Center polish: the match of the day (LIVE and live score), the Matches tab (today in orange, LIVE badge), Russian captions under
// the YouTube videos, the order of the standings table and the Russia default of the players tab.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { handleTelegramCenterV20Ui } from "../cloudflare-worker/src/telegram-center-v20-ui.js";
import { handleTelegramCenterV19Ui } from "../cloudflare-worker/src/telegram-center-v19-ui.js";
import { handleTelegramCenterV15CoreUi } from "../cloudflare-worker/src/telegram-center-v15-core-ui.js";
import { handleTelegramCenterV16Hotfix } from "../cloudflare-worker/src/telegram-center-v16-hotfix.js";
import { handleTelegramCenterV22Ui } from "../cloudflare-worker/src/telegram-center-v22-ui.js";
import { handleTelegramCenterV23PlayerUi } from "../cloudflare-worker/src/telegram-center-v23-player-ui.js";
import { handleTelegramCenterV8Ui } from "../cloudflare-worker/src/telegram-center-v8-ui.js";
import { handleTelegramCenterV7, officialOrder } from "../cloudflare-worker/src/telegram-center-v7.js";

const script = async (handler, path) => (await handler(new Request(`https://x.test${path}`), path)).text();
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const v20 = await script(handleTelegramCenterV20Ui, "/telegram-app/v20.js");
const v19 = await script(handleTelegramCenterV19Ui, "/telegram-app/v19.js");

// ---- 1) the match of the day on the home page ----------------------------------------------------------------------------------
const FEATURED_BASE = {
  game_pk: 2026020100, game_type: 2, scheduled_start_utc: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), game_state: "FUT", home_score: 0, away_score: 0,
  away: { tri: "PHI", name_ru: "Филадельфия Флайерз", logo: "https://l.test/PHI.svg" }, home: { tri: "BOS", name_ru: "Бостон Брюинз", logo: "https://l.test/BOS.svg" },
  vk: null, vk_url: "https://vkvideo.ru/video-1_2", thumbnail_url: null, winline: { p1: 2.2, x: 4.2, p2: 2.75 },
};

function makeHome({ featured, live = null }) {
  const dom = new JSDOM(
    `<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button></nav>
     <main id="view" class="view"><div class="dateBox">2026-10-10</div><div class="toolbar"></div><div id="gameList"><article class="gameCard" data-game="1"></article></div></main></body>`,
    { url: "https://example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;
  const calls = [];
  const box = { live };
  window.HOHV15 = {
    esc, state: { profile: false }, currentTab: () => "games", tabsVisible: () => true, view: () => window.document.getElementById("view"), V2: "/v2",
    api: async (url) => {
      calls.push(url);
      if (url.startsWith("/api/telegram-center-v19/featured")) return { ok: true, featured };
      if (url.startsWith("/api/telegram-center-v26/games/")) { if (!box.live) throw new Error("HTTP 502"); return box.live; }
      return { ok: true, items: [], news: [] };
    },
  };
  window.Telegram = { WebApp: { openLink() {} } };
  window.eval(v20);
  return { window, calls, box, doc: window.document };
}
const livePayload = (away, home, label, code = "LIVE", phase = "live") => ({ ok: true, state: { code, phase, label_ru: label }, teams: { away: { score: away }, home: { score: home } } });

{
  // before the game: the start time, no LIVE, and no polling while the game is hours away
  const { window, calls, doc } = makeHome({ featured: FEATURED_BASE });
  await tick(320);
  const card = doc.querySelector(".v25FeaturedGame");
  assert.ok(card, "the match of the day is on the page");
  assert.match(text(card), /НАЧАЛО МАТЧА/);
  assert.ok(!card.querySelector(".v25LiveBadge"));
  assert.ok(!calls.some((u) => u.includes("/api/telegram-center-v26/")), "a game hours away is not polled");
  window.close();
}
{
  // the game is on: a big red LIVE instead of the start phrase, the score, and it keeps updating by itself
  const live = { ...FEATURED_BASE, game_state: "LIVE", away_score: 0, home_score: 1, scheduled_start_utc: new Date(Date.now() - 3600 * 1000).toISOString() };
  const { window, calls, box, doc } = makeHome({ featured: live, live: livePayload(0, 1, "2-й период · 14:32") });
  await tick(350);
  let card = doc.querySelector(".v25FeaturedGame");
  assert.ok(card.querySelector(".v25LiveBadge"), "big red LIVE");
  assert.ok(!/НАЧАЛО МАТЧА/.test(text(card)), "the start phrase is gone");
  assert.equal(text(card.querySelector(".v25FeaturedScore")), "0 : 1");
  assert.match(text(card.querySelector(".v25FeaturedTime small")), /2-й период · 14:32/);
  assert.ok(calls.some((u) => u === "/api/telegram-center-v26/games/2026020100/goals"), "the score is read from the live feed");
  assert.equal(window.HOHV20.featuredPolling(), true);
  // a goal: the next poll redraws the card with the new score (the poll runs every 15 s; here it is forced through the exposed function)
  box.live = livePayload(1, 1, "2-й период · 16:05");
  const before = card.innerHTML;
  await window.HOHV20.pollFeaturedNow();
  card = doc.querySelector(".v25FeaturedGame");
  assert.equal(text(card.querySelector(".v25FeaturedScore")), "1 : 1", "the score changes without reloading the page");
  assert.notEqual(card.innerHTML, before);
  // nothing changed: nothing is redrawn
  let touched = 0;
  const mo = new window.MutationObserver((records) => { touched += records.length; });
  mo.observe(card, { childList: true, subtree: true, attributes: true, characterData: true });
  await window.HOHV20.pollFeaturedNow();
  await tick(5);
  assert.equal(touched, 0, "an unchanged score does not touch the page");
  mo.disconnect();
  // the game ends: the card shows the final score and stops asking
  box.live = livePayload(2, 1, "Финал", "OFF", "final");
  await window.HOHV20.pollFeaturedNow();
  card = doc.querySelector(".v25FeaturedGame");
  assert.ok(!card.querySelector(".v25LiveBadge"));
  assert.match(text(card), /2 : 1/);
  assert.match(text(card), /ФИНАЛ/);
  assert.equal(window.HOHV20.featuredPolling(), false, "no more polling after the final");
  window.close();
}
{
  // with a cover the LIVE badge sits on the picture and the score replaces the start time under it
  const live = { ...FEATURED_BASE, game_state: "CRIT", away_score: 3, home_score: 3, thumbnail_url: "https://sun9-1.userapi.com/cover.jpg", vk: { source_key: "vk1" }, scheduled_start_utc: new Date(Date.now() - 3600 * 1000).toISOString() };
  const { window, doc } = makeHome({ featured: live, live: livePayload(3, 3, "3-й период · 19:10", "CRIT") });
  await tick(350);
  const card = doc.querySelector(".v25FeaturedGame");
  assert.ok(card.querySelector(".v25FeaturedCover .v25LiveBadge"), "LIVE on the cover");
  assert.equal(text(card.querySelector(".v25FeaturedScoreMeta")), "3 : 3");
  assert.ok(!card.querySelector(".v25FeaturedTeams"), "the logos stay out of the way of the cover");
  window.close();
}
{
  // no-spoilers hides the live score
  const live = { ...FEATURED_BASE, game_state: "LIVE", away_score: 4, home_score: 0, scheduled_start_utc: new Date(Date.now() - 3600 * 1000).toISOString() };
  const { window, doc } = makeHome({ featured: live, live: livePayload(4, 0, "3-й период · 01:00") });
  window.HOHNoSpoilers = () => true;
  await tick(350);
  const card = doc.querySelector(".v25FeaturedGame");
  assert.ok(card.querySelector(".v25LiveBadge"), "LIVE itself is not a spoiler");
  assert.equal(text(card.querySelector(".v25FeaturedScore")), "• : •");
  window.close();
}
{
  // other games of the day and the date bar are not on the home page (they live on the Matches tab)
  assert.match(v20, /\.v25HomeStable>#gameList,\.v25HomeStable>\.toolbar\{display:none!important\}/);
  assert.ok(!/\.v25HomeStable>#gameList\{display:grid/.test(v20));
}

// ---- 2) the Matches tab: today in orange, LIVE next to the VK badge ---------------------------------------------------------
{
  const dom = new JSDOM('<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button><button class="tab" data-tab="teams"></button></nav><main id="view"></main></body>',
    { url: "https://example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const d = new Date();
  const localToday = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const mk = (pk, state, vk) => ({
    calendar_date: localToday, game_pk: pk, game_type: 2, is_playoff: false, scheduled_start_utc: new Date().toISOString(), game_state: state, home_score: 1, away_score: 0, period_type: "REG",
    home: { tri: "BOS", name_ru: "Бостон", logo: "https://l.test/BOS.svg" }, away: { tri: "PHI", name_ru: "Филадельфия", logo: "https://l.test/PHI.svg" },
    vk: vk ? { source_key: "vk" + pk, web_url: "https://vkvideo.ru/video-1_" + pk } : null, winline: null, historical_odds: null,
  });
  const games = [mk(1, "LIVE", true), mk(2, "FUT", true), mk(3, "CRIT", false), mk(4, "OFF", true)];
  window.HOHV15 = {
    esc, state: { profile: false }, currentTab: () => "games", tabsVisible: () => true, view: () => window.document.getElementById("view"), V2: "/v2",
    api: async (url) => {
      if (url.includes("/api/telegram-center-v19/broadcasts")) return { ok: true, days: [{ date: localToday, count: games.length }], games };
      return { ok: true };
    },
    teamLogo: () => "",
  };
  window.Telegram = { WebApp: { openLink() {} } };
  window.eval(v19);
  window.document.querySelector('.tab[data-tab="broadcasts"]').click();
  await tick(60);
  const todayButtons = [...window.document.querySelectorAll(".v19Day.today")];
  assert.equal(todayButtons.length, 1, "exactly one day is today");
  assert.equal(todayButtons[0].dataset.v19Date, localToday, "today by the clock of the device");
  assert.ok(todayButtons[0].classList.contains("sel"), "and it is the selected day by default");
  const badges = [...window.document.querySelectorAll(".v19Broadcast")].map((a) => ({ pk: a.dataset.v19Game, live: Boolean(a.querySelector(".v19LiveBadge")), order: [...a.querySelectorAll(".top > span")].map((s) => s.className) }));
  assert.deepEqual(badges.map((b) => [b.pk, b.live]), [["1", true], ["2", false], ["3", true], ["4", false]], "LIVE only on games that are on (LIVE and CRIT)");
  assert.deepEqual(badges[0].order, ["v19VkBadge", "v19LiveBadge"], "LIVE stands right next to the VK badge");
  assert.deepEqual(badges[2].order, ["v19LiveBadge"], "a live game without a broadcast still shows LIVE");
  assert.match(text(window.document.querySelector(".v19LiveBadge")), /LIVE/);
  // another day selected: today stays orange, the selection moves to the other day
  const otherDay = [...window.document.querySelectorAll(".v19Day")].find((b) => b.dataset.v19Date !== localToday);
  otherDay.click();
  const todayAfter = window.document.querySelector(".v19Day.today");
  assert.ok(todayAfter && !todayAfter.classList.contains("sel"), "today is marked even when another day is selected");
  assert.equal(window.document.querySelectorAll(".v19Day.sel").length, 1);
  assert.match(v19, /\.v19Day\.today\.sel\{background:#ff6a00/);
  window.close();
}

// ---- 3) captions under the YouTube videos are Russian -----------------------------------------------------------------------
{
  const core = await script(handleTelegramCenterV15CoreUi, "/telegram-app/v15-core.js");
  const hotfix = await script(handleTelegramCenterV16Hotfix, "/telegram-app/v16.js");
  // the function each layer really uses for the caption under a video: v15 calls it shortTitle, v16 calls it title
  for (const [src, fn] of [[core, "shortTitle"], [hotfix, "title"]]) {
    const helper = /function ruMediaTitle\(s,kind\)\{[^\n]*\}\n/.exec(src);
    const caption = new RegExp(`function ${fn}\\((?:s|x),kind\\)\\{[^\\n]*\\}\\n`).exec(src);
    assert.ok(helper && caption, `the caption helper and ${fn} are in the layer`);
    const ruTitle = new Function(`${helper[0]}${caption[0]}return ${fn};`)();
    assert.equal(ruTitle("🤯 Что делает Овечкин...? #shorts", "short"), "🤯 Что делает Овечкин...?", "Russian captions stay, hashtags go");
    assert.equal(ruTitle("SHESTYORKIN INJURED? | CROSBY FLOPPED THE PENGUINS", "news"), "Свежий выпуск новостей НХЛ", "an English title becomes a Russian caption");
    assert.equal(ruTitle("HOME OF HOCKEY SHORTS", "short"), "Короткое видео Home of Hockey");
    assert.equal(ruTitle("", "news"), "Свежий выпуск новостей НХЛ");
    assert.equal(ruTitle(undefined, "short"), "Короткое видео Home of Hockey");
    assert.ok(ruTitle("Очень длинное русское название ролика которое не поместится в одну строку подписи", "short").endsWith("…"), "long captions are still cut");
  }
  assert.match(core, /shortTitle\(x\.title,x\.kind\)/);
  assert.match(hotfix, /title\(x\.title,x\.kind\)/);
}

// ---- 4) the standings table: official order, games played and points -----------------------------------------------------------
{
  const rows = [
    { tri: "BOS", pts: 6, gp: 5, w: 3, division_rank: 4 }, { tri: "OTT", pts: 6, gp: 4, w: 3, division_rank: 1 },
    { tri: "TBL", pts: 6, gp: 4, w: 3, division_rank: 2 }, { tri: "FLA", pts: 6, gp: 4, w: 2, division_rank: 3 },
  ];
  assert.deepEqual([...rows].sort(officialOrder).map((r) => r.tri), ["OTT", "TBL", "FLA", "BOS"], "the same points: the official place decides");
  const early = [{ tri: "B", name: "Бета", pts: 0, gp: 0, w: 0, division_rank: null }, { tri: "A", name: "Альфа", pts: 0, gp: 0, w: 0, division_rank: null }, { tri: "C", name: "Чуть", pts: 2, gp: 1, w: 1, division_rank: 1 }];
  assert.deepEqual([...early].sort(officialOrder).map((r) => r.tri), ["C", "A", "B"], "ranked teams first, the rest by name");
  const noRanks = [{ tri: "X", name: "Икс", pts: 4, gp: 3, w: 2 }, { tri: "Y", name: "Игрек", pts: 4, gp: 2, w: 2 }, { tri: "Z", name: "Зет", pts: 5, gp: 4, w: 2 }];
  assert.deepEqual([...noRanks].sort(officialOrder).map((r) => r.tri), ["Z", "Y", "X"], "without ranks: points, then fewer games played");

  // the whole route with a stubbed database and a stubbed NHL feed
  const realFetch = globalThis.fetch;
  const emptyEnv = { DB: { prepare: () => ({ all: async () => ({ results: [] }) }) } };
  globalThis.fetch = async () => new Response(JSON.stringify({ standings: [] }), { status: 200 });
  const season = (await (await handleTelegramCenterV7(new Request("https://x.test/api/telegram-center-v7/standings"), emptyEnv, "/api/telegram-center-v7/standings")).json()).season;
  const nhlRow = (tri, gp, pts, wins, seq, confSeq) => ({ seasonId: season, teamAbbrev: { default: tri }, gamesPlayed: gp, points: pts, wins, losses: gp - wins, otLosses: 0, divisionSequence: seq, conferenceSequence: confSeq, wildcardSequence: 0, clinchIndicator: "" });
  globalThis.fetch = async () => new Response(JSON.stringify({ standings: [nhlRow("BOS", 5, 6, 3, 4, 7), nhlRow("OTT", 4, 6, 3, 1, 4), nhlRow("TBL", 4, 6, 3, 2, 5), nhlRow("FLA", 4, 6, 2, 3, 6)] }), { status: 200 });
  const env = { DB: { prepare: () => ({ all: async () => ({ results: ["BOS", "OTT", "TBL", "FLA"].map((t) => ({ tri_code: t, name_en: t, name_ru: t, logo_url: null })) }) }) } };
  const body = await (await handleTelegramCenterV7(new Request("https://x.test/api/telegram-center-v7/standings"), env, "/api/telegram-center-v7/standings")).json();
  const atlantic = body.conferences[0].divisions[0].rows.filter((r) => r.gp > 0).map((r) => r.tri);
  assert.deepEqual(atlantic, ["OTT", "TBL", "FLA", "BOS"], "the route lists the division in the official order");
  globalThis.fetch = realFetch;

  const v8 = await script(handleTelegramCenterV8Ui, "/telegram-app");
  assert.match(v8, /Команды стоят так же, как в официальной таблице НХЛ\. И — сыграно матчей, О — набрано очков\./, "a note on top");
  assert.match(v8, /class=\\?"standingHead\\?"/, "column headers");
  assert.match(v8, /<div class=\\?"gp\\?">'\+esc\(r\.gp\|\|0\)\+'<\/div><div class=\\?"pts\\?">'\+esc\(r\.pts\|\|0\)\+'<\/div>/, "games played and points in two columns");
  assert.ok(!/\+' оч\.<\/div>/.test(v8), "no more 'оч.' in the row");
  assert.match(v8, /grid-template-columns:22px 28px 1fr 34px 40px/);
  // the players tab opens on Russia, by points
  assert.match(v8, /playerSort:'points',playerLimit:10,country:'RUS'/);
}

// ---- 5) the eye and the gear share the row of the back button; the player's last game honours no-spoilers ---------------------------
{
  const v22 = await script(handleTelegramCenterV22Ui, "/telegram-app/v22.js");
  assert.match(v22, /\.v22BackRow\{grid-template-columns:minmax\(0,1fr\) 42px 42px!important\}/);
  assert.match(v22, /wrap\.appendChild\(b\);wrap\.appendChild\(settingsButton\(\)\);syncSettingsButton\(\);return;/);
  const v23 = await script(handleTelegramCenterV23PlayerUi, "/telegram-app/v23-player.js");
  assert.match(v23, /score=final\(g\)\?\(typeof window\.HOHNoSpoilers==='function'&&window\.HOHNoSpoilers\(\)===true\?'• : •'/, "the score of the last game is hidden in no-spoilers mode");
  assert.match(v23, /addEventListener\('hoh-spoilers-change',\(\)=>\{if\(STATE\.current&&document\.querySelector\('\.v23PlayerProfile:not\(\.v23StatsPage\)'\)\)renderMain\(STATE\.current\)\}\)/, "and the profile redraws when the switch is flipped");
}

// ---- 6) our mini covers: the Worker publishes them, lists and the match of the day show them -----------------------------------
import { coverUrlsFrom, loadCoverUrls, clipsBaseOf } from "../cloudflare-worker/src/telegram-center-v26-covers.js";
import { handleTelegramCenterV19ProductData } from "../cloudflare-worker/src/telegram-center-v19-product-data.js";

{
  const base = "https://clips.test";
  assert.deepEqual(coverUrlsFrom({ version: 1, covers: { 2026020069: 1791656387, abc: 5, 2026020070: "x", "12x": 1 } }, base), {
    2026020069: `${base}/covers/2026020069.jpg?v=1791656387`, 2026020070: `${base}/covers/2026020070.jpg?v=0`,
  }, "only numeric game ids, a broken version becomes 0");
  assert.deepEqual(coverUrlsFrom(null, base), {});
  assert.deepEqual(coverUrlsFrom({ covers: "no" }, base), {});
  assert.equal(clipsBaseOf({ HOH_CLIPS_BASE: " https://other.test/ " }), "https://other.test");
  assert.match(clipsBaseOf({}), /^https:\/\//);

  const realFetch = globalThis.fetch;
  const env = { HOH_CLIPS_BASE: base };
  let asked = "";
  globalThis.fetch = async (url) => { asked = String(url); return new Response(JSON.stringify({ version: 1, covers: { 2026020100: 123 } }), { status: 200 }); };
  assert.deepEqual(await loadCoverUrls(env), { 2026020100: `${base}/covers/2026020100.jpg?v=123` });
  assert.equal(asked, `${base}/covers.json`);
  globalThis.fetch = async () => new Response("no", { status: 502 });
  assert.deepEqual(await loadCoverUrls(env), {}, "clip server answers an error: no mini covers");
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.deepEqual(await loadCoverUrls(env), {}, "clip server down: no mini covers, no failure");
  globalThis.fetch = async () => new Response("not json", { status: 200 });
  assert.deepEqual(await loadCoverUrls(env), {}, "a broken file is ignored");

  // the lists carry cover_url next to the VK picture
  const archiveRow = (pk, key) => ({
    calendar_date: "2026-10-10", game_pk: pk, season_id: "20262027", game_type: 2, scheduled_start_utc: "2026-10-10T17:00:00Z", game_state: "LIVE", home_tri: "BOS", away_tri: "PHI",
    home_score: 2, away_score: 1, period_type: "REG", venue_name: "TD Garden", home_name_en: "Boston", home_name_ru: "Бостон", away_name_en: "Philadelphia", away_name_ru: "Филадельфия",
    source_key: key, vk_title: "t", vk_url: "https://vkvideo.ru/video-1_" + pk, vk_thumbnail: key ? "https://sun9-1.userapi.com/c.jpg" : null,
  });
  const db = (rows) => ({ prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }), first: async () => null }), all: async () => ({ results: [] }) }) });
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, covers: { 2026020100: 123 } }), { status: 200 });
  const listEnv = { HOH_CLIPS_BASE: base, DB: db([archiveRow(2026020100, "vk1"), archiveRow(2026020101, "vk2")]) };
  const list = await (await handleTelegramCenterV19ProductData(new Request("https://x.test/api/telegram-center-v19/broadcasts?from=2026-10-10&to=2026-10-10"), listEnv, "/api/telegram-center-v19/broadcasts")).json();
  assert.equal(list.ok, true);
  assert.equal(list.games.find((g) => g.game_pk === 2026020100).cover_url, `${base}/covers/2026020100.jpg?v=123`);
  assert.equal(list.games.find((g) => g.game_pk === 2026020101).cover_url, null, "a game without a kept cover keeps the VK picture only");
  assert.ok(list.games.every((g) => g.vk && g.vk.thumbnail_url), "the VK picture is still there as the second choice");
  globalThis.fetch = async () => { throw new Error("offline"); };
  const offline = await (await handleTelegramCenterV19ProductData(new Request("https://x.test/api/telegram-center-v19/broadcasts?from=2026-10-10&to=2026-10-10"), listEnv, "/api/telegram-center-v19/broadcasts")).json();
  assert.equal(offline.ok, true, "clip server down: the list still loads");
  assert.ok(offline.games.every((g) => g.cover_url === null));

  // the match of the day
  const featRow = { ...archiveRow(2026020100, "vk1"), vk_app_url: null, vk_status: "live", winline_event_id: null, winline_p1: null, winline_x: null, winline_p2: null, home_logo: null, away_logo: null };
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, covers: { 2026020100: 123 } }), { status: 200 });
  const featEnv = { HOH_CLIPS_BASE: base, DB: db([featRow]) };
  const feat = await (await handleTelegramCenterV19ProductData(new Request("https://x.test/api/telegram-center-v19/featured?date=2026-10-10"), featEnv, "/api/telegram-center-v19/featured")).json();
  assert.equal(feat.ok, true);
  assert.equal(feat.featured.cover_url, `${base}/covers/2026020100.jpg?v=123`);
  assert.equal(feat.featured.thumbnail_url, "https://sun9-1.userapi.com/c.jpg", "the VK picture stays as the second choice");
  globalThis.fetch = realFetch;
}

{
  // Matches tab: mini cover → VK picture → logos, and a score for a game that is on
  const dom = new JSDOM('<!doctype html><body><nav id="tabs"><button class="tab active" data-tab="games"></button><button class="tab" data-tab="teams"></button></nav><main id="view"></main></body>',
    { url: "https://example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const d = new Date();
  const today = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const mk = (pk, state, extra) => ({
    calendar_date: today, game_pk: pk, game_type: 2, is_playoff: false, scheduled_start_utc: new Date().toISOString(), game_state: state, home_score: 2, away_score: 1, period_type: "REG",
    home: { tri: "BOS", name_ru: "Бостон", logo: "https://l.test/BOS.svg" }, away: { tri: "PHI", name_ru: "Филадельфия", logo: "https://l.test/PHI.svg" },
    vk: null, winline: null, historical_odds: null, cover_url: null, ...extra,
  });
  const vk = (n) => ({ source_key: "vk" + n, web_url: "https://vkvideo.ru/video-1_" + n, thumbnail_url: "https://sun9-1.userapi.com/c" + n + ".jpg" });
  const games = [
    mk(1, "LIVE", { vk: vk(1), cover_url: "https://clips.test/covers/1.jpg?v=5" }),
    mk(2, "OFF", { vk: vk(2), period_type: "OT", home_score: 3, away_score: 4 }),
    mk(3, "FUT", {}),
  ];
  window.HOHV15 = {
    esc, state: { profile: false }, currentTab: () => "games", tabsVisible: () => true, view: () => window.document.getElementById("view"), V2: "/v2",
    api: async (url) => (url.includes("/api/telegram-center-v19/broadcasts") ? { ok: true, days: [{ date: today, count: 3 }], games } : { ok: true }),
    teamLogo: () => "",
  };
  window.Telegram = { WebApp: { openLink() {} } };
  window.eval(v19);
  window.document.querySelector('.tab[data-tab="broadcasts"]').click();
  await tick(60);
  const doc = window.document;
  const card = (pk) => doc.querySelector(`[data-v19-game="${pk}"]`);
  assert.equal(card(1).querySelector(".v19Thumb img").getAttribute("src"), "https://clips.test/covers/1.jpg?v=5", "our mini cover first");
  assert.equal(card(2).querySelector(".v19Thumb img").getAttribute("src"), "/api/telegram-center-media/vk-cover?source_key=vk2", "no mini cover: the VK picture");
  assert.ok(card(3).querySelector(".v19ThumbTeams"), "no picture at all: the logos");
  assert.deepEqual([1, 2].map((pk) => text(card(pk).querySelector(".v19CardScore"))), ["1 : 2", "4 : 3 ОТ"], "a game that is on shows its score");
  // 2026-10-19, the owner: the names once, the start time between them, no «регулярный сезон»
  const time = new window.Date(games[2].scheduled_start_utc).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  assert.equal(card(3).querySelector(".v19CardScore"), null, "a game ahead has no score");
  assert.equal(text(card(3).querySelector(".v19ThumbTeams .v19CardMid")), time, "the start time between the logos");
  assert.deepEqual([...card(3).querySelectorAll(".v19ThumbTeams [data-v19-side]")].map((x) => text(x)), ["Филадельфия", "Бостон"]);
  assert.equal(card(3).querySelector(".v19Board"), null, "under the logos the names are not written again");
  assert.equal(text(card(1).querySelector(".v19Board")), "Филадельфия 1 : 2 Бостон", "under a cover: the names once and the score between them");
  for (const pk of [1, 2, 3]) {
    assert.ok(!/регулярный сезон/i.test(text(card(pk))), "no «регулярный сезон»");
    assert.equal(card(pk).querySelector(".v19BroadcastText small"), null, "no small line");
    assert.equal((text(card(pk)).match(/Филадельфия/g) || []).length, 1, "each name once");
  }
  // our cover fails: the VK picture takes its place; then the logos; and nothing is retried in a loop
  card(1).querySelector(".v19Thumb img").dispatchEvent(new window.Event("error"));
  assert.equal(card(1).querySelector(".v19Thumb img").getAttribute("src"), "/api/telegram-center-media/vk-cover?source_key=vk1");
  card(1).querySelector(".v19Thumb img").dispatchEvent(new window.Event("error"));
  assert.ok(card(1).querySelector(".v19ThumbTeams") && !card(1).querySelector(".v19Thumb img[src*=covers]"));
  assert.equal(card(1).querySelector(".v19Board"), null, "the logos carry the names now: the line under them goes");
  assert.equal((text(card(1)).match(/Филадельфия/g) || []).length, 1);
  window.close();
}

{
  // the match of the day: mini cover → VK picture → the logos
  const base = { ...FEATURED_BASE, thumbnail_url: "https://sun9-1.userapi.com/cover.jpg", vk: { source_key: "vk9" }, cover_url: "https://clips.test/covers/9.jpg?v=3" };
  const { window, doc } = makeHome({ featured: base });
  await tick(320);
  const img = () => doc.querySelector(".v25FeaturedCover img");
  assert.equal(img().getAttribute("src"), "https://clips.test/covers/9.jpg?v=3", "our mini cover first");
  img().dispatchEvent(new window.Event("error"));
  assert.equal(img().getAttribute("src"), "/api/telegram-center-media/vk-cover?source_key=vk9", "then the VK picture");
  img().dispatchEvent(new window.Event("error"));
  assert.ok(!img() && doc.querySelector(".v25FeaturedTeams"), "then the logos");
  window.close();
  const plain = makeHome({ featured: { ...FEATURED_BASE, thumbnail_url: null, vk: null, cover_url: null } });
  await tick(320);
  assert.ok(plain.doc.querySelector(".v25FeaturedTeams") && !plain.doc.querySelector(".v25FeaturedCover"), "no cover anywhere: the logos");
  plain.window.close();
}

console.log("APP_POLISH_OK");
process.exit(0);
