// Live Center match screen: VK cover, Winline line, goals with scorers/assists, clips played inside the app, LIVE updates,
// no-spoilers, and the page with every goal of a player.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildGoalsPayload, buildPlayerSeasonPayload, regulationResult, playerIdsOf, periodInfo, phaseOf, stateInfo } from "../cloudflare-worker/src/telegram-center-v26-goals-data.js";
import { handleTelegramCenterV26, seasonIdOf, FONT_CSS, FONT_PRELOAD_LINKS, directCover } from "../cloudflare-worker/src/telegram-center-v26-goals.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";
import { handleTelegramCenterV19Ui } from "../cloudflare-worker/src/telegram-center-v19-ui.js";

const BASE = "https://clips.example.test";
const NOW = Date.parse("2026-10-10T19:30:00Z");

const name = (first, last) => ({ firstName: { default: first }, lastName: { default: last } });
function goal(eventId, playerId, team, isHome, first, last, time, away, home, extra = {}) {
  return {
    eventId, playerId, teamAbbrev: { default: team }, isHome, ...name(first, last), timeInPeriod: time,
    awayScore: away, homeScore: home, strength: "ev", goalModifier: "none", goalsToDate: 1, headshot: `https://mugs.example.test/${playerId}.png`,
    assists: [], ...extra,
  };
}
function landing({ state = "LIVE", period = { number: 2, periodType: "REG" }, start = "2026-10-10T17:00:00Z", clock = { timeRemaining: "14:32", running: true, inIntermission: false }, away = 1, home = 2 } = {}) {
  return {
    id: 123, gameState: state, startTimeUTC: start, periodDescriptor: period, clock,
    awayTeam: { abbrev: "PHI", score: away, sog: 18 }, homeTeam: { abbrev: "BOS", score: home, sog: 24 },
    summary: {
      scoring: [
        { periodDescriptor: { number: 1, periodType: "REG" }, goals: [
          goal(405, 8477956, "BOS", true, "David", "Pastrnak", "06:12", 0, 1, { assists: [{ playerId: 8473419, ...name("Brad", "Marchand"), sweaterNumber: 63 }, { playerId: 8480727, ...name("Charlie", "McAvoy"), sweaterNumber: 73 }] }),
          goal(407, 8478398, "PHI", false, "Travis", "Konecny", "15:40", 1, 1, { strength: "pp" }),
        ] },
        { periodDescriptor: { number: 2, periodType: "REG" }, goals: [
          goal(410, 8473419, "BOS", true, "Brad", "Marchand", "11:03", 1, 2, { goalModifier: "empty-net" }),
        ] },
      ],
    },
  };
}
const NAMES = new Map([[8477956, "Давид Пастрняк"], [8473419, "Брэд Маршан"], [8480727, "Чарли Макэвой"]]);
const clip = (path, light = true, poster = true) => ({ orig: { path, bytes: 36_000_000 }, light: light ? { path: "tg/" + path, bytes: 10_500_000 } : null, poster: poster ? path.replace(".mp4", ".jpg") : null, duration: 44.2 });
const INDEX = {
  version: 1,
  games: [
    { game_pk: 123, date: "20261010", kind: "live", away: "PHI", home: "BOS",
      goals: [
        { event_id: 405, scorer_id: 8477956, away_score: 0, home_score: 1, ...clip("live/20261010/phi-bos/a.mp4") },
        { event_id: 407, scorer_id: 8478398, away_score: 1, home_score: 1, ...clip("live/20261010/phi-bos/b.mp4", false, false) },
      ] },
    { game_pk: 123, date: "20261008", kind: "vod", away: "PHI", home: "BOS", goals: [] },
  ],
  covers: { 123: { path: "covers/123.jpg", bytes: 41_000, mtime: 1760000000 } },
};

// ---- 1) data: join of NHL goals and clips ---------------------------------------------------------------------------------
{
  const p = buildGoalsPayload({ gamePk: 123, landing: landing(), index: INDEX, indexOk: true, names: NAMES, now: NOW, clipsBase: BASE });
  assert.equal(p.state.phase, "live");
  assert.equal(p.state.label_ru, "2-й период · 14:32");
  assert.deepEqual(p.teams, { away: { tri: "PHI", score: 1, shots: 18 }, home: { tri: "BOS", score: 2, shots: 24 } });
  assert.equal(p.goals.length, 3);
  const [g1, g2, g3] = p.goals;
  assert.equal(g1.event_id, 405);
  assert.equal(g1.scorer.name_ru, "Давид Пастрняк");
  assert.equal(g1.scorer.name_en, "David Pastrnak");
  assert.deepEqual(g1.assists.map((a) => a.name_ru), ["Брэд Маршан", "Чарли Макэвой"]);
  assert.deepEqual(g1.period, { number: 1, type: "REG", label_ru: "1-й период", short_ru: "1-й" });
  assert.equal(g1.time, "06:12");
  assert.deepEqual(g1.score_after, { away: 0, home: 1 });
  assert.deepEqual(g1.clip, { state: "ready", url: `${BASE}/tg/live/20261010/phi-bos/a.mp4`, poster_url: `${BASE}/live/20261010/phi-bos/a.jpg`, duration: 44.2, bytes: 10_500_000 }, "one file: the 1080p copy made for the app");
  assert.ok(!("orig_url" in g1.clip) && !("light_url" in g1.clip), "no choice of quality is exposed");
  assert.equal(g2.strength_label_ru, "большинство");
  assert.equal(g2.scorer.name_ru, null, "unknown player falls back to the English name on screen");
  assert.equal(g2.clip.url, `${BASE}/live/20261010/phi-bos/b.mp4`, "no app copy yet: the original is only a fallback");
  assert.equal(g2.clip.poster_url, null);
  assert.equal(g3.modifier_label_ru, "в пустые ворота");
  assert.equal(g3.clip.state, "pending", "live game, clip not cut yet");
  assert.deepEqual(p.clips, { server_ok: true, available: true, ready: 2, total: 3 }, "no compilations in the payload");
  assert.equal(p.result, null, "no result while the game is on");
  assert.equal(p.cover_url, `${BASE}/covers/123.jpg?v=1760000000`, "cover kept on our server");
  assert.deepEqual(playerIdsOf(landing()).sort(), [8473419, 8477956, 8478398, 8480727]);

  // covers.json (every cover ever kept) wins over the older copy listed in index.json; a game it does not list falls back to the index
  const fromList = buildGoalsPayload({ gamePk: 123, landing: landing(), index: INDEX, indexOk: true, names: NAMES, now: NOW, clipsBase: BASE, covers: { 123: `${BASE}/covers/123.jpg?v=9` } });
  assert.equal(fromList.cover_url, `${BASE}/covers/123.jpg?v=9`);
  assert.equal(buildGoalsPayload({ gamePk: 123, landing: landing(), index: INDEX, indexOk: true, names: NAMES, now: NOW, clipsBase: BASE, covers: { 999: "x" } }).cover_url, `${BASE}/covers/123.jpg?v=1760000000`);
  assert.equal(buildGoalsPayload({ gamePk: 124, landing: landing(), index: null, indexOk: false, now: NOW, clipsBase: BASE, covers: { 124: `${BASE}/covers/124.jpg?v=2` } }).cover_url, `${BASE}/covers/124.jpg?v=2`, "a cover is shown even when the goals index is down");

  const noServer = buildGoalsPayload({ gamePk: 123, landing: landing(), index: null, indexOk: false, now: NOW, clipsBase: BASE });
  assert.ok(noServer.goals.every((g) => g.clip.state === "none"), "server down: no fake 'pending' spinners");
  assert.equal(noServer.clips.server_ok, false);
  assert.equal(noServer.cover_url, null);

  const finalRecent = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "OFF", clock: { timeRemaining: "00:00" } }), index: INDEX, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(finalRecent.state.label_ru, "Финал");
  assert.equal(finalRecent.goals[2].clip.state, "pending", "just finished: the last clip is still being cut");
  const finalOld = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "OFF" }), index: INDEX, indexOk: true, now: Date.parse("2026-10-11T12:00:00Z"), clipsBase: BASE });
  assert.equal(finalOld.goals[2].clip.state, "none", "long after the game there is no clip to wait for");
  const otFinal = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "FINAL", period: { number: 4, periodType: "OT" } }), index: INDEX, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(otFinal.state.label_ru, "Финал · ОТ");
  // a shootout under way: the series score, not the clock that always reads 00:00 (DAL–COL 2026-10-15: "Буллиты · 00:00" looked like a stuck overtime)
  const shootout = { gameState: "CRIT", startTimeUTC: "2026-10-11T00:00:00Z", periodDescriptor: { number: 5, periodType: "SO" }, clock: { timeRemaining: "00:00", running: false }, awayTeam: { abbrev: "DAL", score: 2 }, homeTeam: { abbrev: "COL", score: 2 } };
  assert.equal(stateInfo({ ...shootout, summary: { shootout: { liveScore: { home: 0, away: 1 } } } }).label_ru, "Буллиты · 1:0", "guests first, like the cards");
  assert.equal(stateInfo(shootout).label_ru, "Буллиты", "no series score yet: just the word");
  assert.equal(stateInfo({ ...shootout, gameState: "OFF" }).label_ru, "Финал · Б");
  const unknownGame = buildGoalsPayload({ gamePk: 999, landing: landing(), index: INDEX, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(unknownGame.clips.available, false);
  assert.equal(unknownGame.cover_url, null, "a cover belongs to its own game");
  assert.equal(periodInfo({ number: 6, periodType: "OT" }).label_ru, "3-й овертайм");
  assert.equal(phaseOf("CRIT"), "live");
  assert.equal(buildGoalsPayload({ gamePk: 123, landing: { gameState: "FUT", startTimeUTC: "2026-10-11T00:00:00Z", awayTeam: { abbrev: "AAA" }, homeTeam: { abbrev: "BBB" } }, now: NOW }).goals.length, 0);

  // the 1X2 line is settled on regulation time: overtime and shootout games are draws
  assert.equal(regulationResult(landing({ state: "OFF", away: 1, home: 2 })), "1", "home won in regulation");
  assert.equal(regulationResult(landing({ state: "OFF", away: 3, home: 2 })), "2", "away won in regulation");
  assert.equal(regulationResult(landing({ state: "OFF", away: 3, home: 2, period: { number: 4, periodType: "OT" } })), "X", "decided in overtime: regulation was tied");
  assert.equal(regulationResult(landing({ state: "OFF", away: 2, home: 3, period: { number: 5, periodType: "SO" } })), "X", "decided in a shootout");
  assert.equal(regulationResult(landing()), null, "not final yet");
  assert.equal(otFinal.result, "X");
  assert.equal(finalOld.result, "1");
}

// ---- 2) routes ------------------------------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
function stubFetch({ landingOk = true, indexOk = true } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api-web.nhle.com")) return landingOk ? new Response(JSON.stringify(landing()), { status: 200 }) : new Response("no", { status: 503 });
    if (u.endsWith("/index.json")) return indexOk ? new Response(JSON.stringify(INDEX), { status: 200 }) : new Response("no", { status: 502 });
    if (u.endsWith("/covers.json")) return indexOk ? new Response(JSON.stringify({ version: 1, covers: { 123: 7 } }), { status: 200 }) : new Response("no", { status: 502 });
    return new Response("unexpected " + u, { status: 500 });
  };
}
{
  const db = { prepare: () => ({ bind: (...ids) => ({ all: async () => ({ results: ids.filter((id) => NAMES.has(id)).map((id) => ({ player_id: id, full_name_ru: NAMES.get(id) })) }) }) }) };
  const env = { DB: db, HOH_CLIPS_BASE: BASE };
  stubFetch();
  const ok = await handleTelegramCenterV26(new Request("https://x.test/api/telegram-center-v26/games/123/goals"), env, "/api/telegram-center-v26/games/123/goals");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.equal(body.goals[0].scorer.name_ru, "Давид Пастрняк", "Russian names come from the players table");
  assert.equal(body.goals[0].clip.url, `${BASE}/tg/live/20261010/phi-bos/a.mp4`);
  assert.equal(body.cover_url, `${BASE}/covers/123.jpg?v=7`, "the route reads covers.json from the clip server");
  stubFetch({ indexOk: false });
  const noClips = await (await handleTelegramCenterV26(new Request("https://x.test/a"), env, "/api/telegram-center-v26/games/123/goals")).json();
  assert.equal(noClips.clips.server_ok, false, "clip server down does not break the goals");
  assert.equal(noClips.goals.length, 3);
  stubFetch({ landingOk: false });
  const nhlDown = await handleTelegramCenterV26(new Request("https://x.test/a"), env, "/api/telegram-center-v26/games/123/goals");
  assert.equal(nhlDown.status, 502);
  const post = await handleTelegramCenterV26(new Request("https://x.test/a", { method: "POST" }), env, "/api/telegram-center-v26/games/123/goals");
  assert.equal(post.status, 405);
  assert.equal(await handleTelegramCenterV26(new Request("https://x.test/other"), env, "/api/other"), null);
  globalThis.fetch = realFetch;

  const script = await handleTelegramCenterV26(new Request("https://x.test/telegram-app/v26-goals.js"), env, "/telegram-app/v26-goals.js");
  const js = await script.text();
  assert.ok(js.includes("openGameV26"));
  new Function(js);
  const css = await (await handleTelegramCenterV26(new Request("https://x.test/c"), env, "/telegram-app/hoh-font.css")).text();
  assert.equal(css, FONT_CSS);
  assert.equal((css.match(/@font-face/g) || []).length, 4, "cyrillic, cyrillic-ext, latin, latin-ext");
  assert.match(css, /font-weight:100 900/);
  assert.match(css, /\*,\*::before,\*::after\{font-family:"Inter"[^}]*!important;font-synthesis:none\}/, "every element uses the one font");
  const fontAsset = new Response("FONTBYTES", { status: 200, headers: { "content-type": "application/octet-stream" } });
  const fontRes = await handleTelegramCenterV26(new Request("https://x.test/telegram-app/fonts/inter-cyrillic-wght-normal.woff2?v=5.3.0"), { ASSETS: { fetch: async () => fontAsset } }, "/telegram-app/fonts/inter-cyrillic-wght-normal.woff2");
  assert.equal(fontRes.headers.get("content-type"), "font/woff2");
  assert.match(fontRes.headers.get("cache-control"), /immutable/);
  assert.equal(await handleTelegramCenterV26(new Request("https://x.test/telegram-app/fonts/evil.woff2"), { ASSETS: { fetch: async () => fontAsset } }, "/telegram-app/fonts/evil.woff2"), null, "only the four Inter files are served");
}

// ---- 3) the app shell loads the font and the screen -------------------------------------------------------------------------
{
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/hoh-font.css?v=26.0"), "font stylesheet in <head>");
  assert.ok(shell.includes(FONT_PRELOAD_LINKS), "font preloaded");
  assert.ok(shell.indexOf("/telegram-app/v26-goals.js") > shell.indexOf("/telegram-app/v24-visual.js"), "match screen loads after the visual layer");
  assert.ok(shell.indexOf("/telegram-app/v26-goals.js") < shell.indexOf("/telegram-app/game-follow.js"));
  assert.ok(shell.indexOf("</head>") > shell.indexOf("hoh-font.css"));
}

// ---- 4) the screen itself ---------------------------------------------------------------------------------------------------
const v26src = await (await handleTelegramCenterV26(new Request("https://x.test/s"), {}, "/telegram-app/v26-goals.js")).text();
const VK = "https://vkvideo.ru/video-1_2";
const V19 = {
  game: { game_pk: 123, game_state: "LIVE", scheduled_start_utc: "2026-10-10T17:00:00Z", venue_name: "TD Garden", away_score: 1, home_score: 2,
    away: { tri: "PHI", name_ru: "Филадельфия Флайерз", logo: "https://l.example.test/PHI.svg" }, home: { tri: "BOS", name_ru: "Бостон Брюинз", logo: "https://l.example.test/BOS.svg" } },
  winline: { markets: [{ outcome_key: "home", odds: 2.2 }, { outcome_key: "draw", odds: 4.2 }, { outcome_key: "away", odds: 2.75 }] },
  broadcast: { source_key: "vk1", web_url: VK, thumbnail_url: "https://vk.test/x.jpg" },
};
const livePayload = () => buildGoalsPayload({ gamePk: 123, landing: landing(), index: INDEX, indexOk: true, names: NAMES, now: NOW, clipsBase: BASE });

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
function makeScreen({ v19 = V19, payload = livePayload() } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav id="tabs"></nav><main id="view"></main></body>', { url: "https://hoh.example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLMediaElement.prototype.play = function play() { this.__played = true; return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  window.HTMLMediaElement.prototype.load = function load() {};
  const opened = [];
  window.Telegram = { WebApp: { openLink: (url) => opened.push(url) } };
  const calls = { api: [], player: [], team: [], back: 0, opened };
  const box = { payload };
  window.HOHV15 = {
    state: { profile: false }, currentTab: () => "games", view: () => window.document.getElementById("view"),
    backRow: (kind) => `<div class="v15BackRow"><button class="v15Back" id="v15Back">‹</button><div>${kind}</div></div>`,
    goBack: () => { calls.back += 1; },
    openPlayer: (id) => calls.player.push(id), openTeam: (tri) => calls.team.push(tri),
    api: async (url) => {
      calls.api.push(url);
      if (url.includes("/api/telegram-center-v19/games/")) { if (!v19) throw new Error("HTTP 500"); return v19; }
      if (url.includes("/api/telegram-center-v26/games/")) { if (!box.payload) throw new Error("HTTP 502"); return box.payload; }
      throw new Error("unexpected " + url);
    },
  };
  window.eval(v26src);
  return { window, calls, box, doc: window.document, H: window.HOHV15 };
}
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

{
  const { window, calls, box, doc, H } = makeScreen();
  await H.openGameV26(123, { returnTab: "games" });
  assert.equal(doc.getElementById("tabs").style.display, "none", "tab bar is hidden on the match screen");
  const rootEl = doc.getElementById("v26Root");
  assert.ok(rootEl.classList.contains("v15Profile"), "profile marker: the settings layer puts the eye and the gear on the back-button row");
  assert.ok(!doc.querySelector(".v26Tabs, [data-v26-tab]"), "no tabs");
  assert.ok(doc.querySelector(".v26Pill.live"), "LIVE badge");
  assert.match(text(doc.querySelector(".v26Pill")), /LIVE · 2-й период · 14:32/);
  assert.equal(text(doc.querySelector(".v26Score")), "1 : 2");
  assert.match(text(doc.querySelector(".v26Shots")), /Броски 18 : 24/);
  assert.deepEqual([...doc.querySelectorAll(".v26Team b")].map(text), ["PHI", "BOS"]);
  assert.match(text(doc.querySelector(".v26When2")), /TD Garden/);
  // the VK cover replaces the picture with the logos and links to the broadcast
  const cover = doc.querySelector("a.v26Cover");
  assert.ok(cover, "cover of the broadcast");
  assert.equal(cover.getAttribute("href"), VK);
  assert.equal(cover.dataset.link, VK);
  assert.equal(cover.querySelector("img").getAttribute("src"), `${BASE}/covers/123.jpg?v=1760000000`, "the copy on our server comes first");
  assert.ok(!doc.querySelector(".v26Team img"), "no team logos next to a cover");
  assert.ok(!doc.querySelector(".v26Vk"), "the cover is the link: no extra button");
  cover.click();
  assert.deepEqual(calls.opened, [VK], "the cover opens the broadcast");
  // the Winline panel: official logo and the line, nothing highlighted while the game is on
  const wl = doc.querySelector(".v26Wl");
  assert.ok(wl, "Winline panel");
  assert.match(wl.querySelector("img.v26WlLogo").getAttribute("src"), /^\/broadcast\/winline-logo\.png/);
  // the odds stand under their teams, as in the head of the match: the guests (PHI) on the left, the hosts (BOS) on the right
  assert.deepEqual([...wl.querySelectorAll(".v26Odd small")].map(text), ["PHI", "Н", "BOS"]);
  assert.deepEqual([...wl.querySelectorAll(".v26Odd b")].map(text), ["2.75", "4.20", "2.20"]);
  assert.deepEqual([...wl.querySelectorAll(".v26Odd i")].map(text), ["победа", "ничья", "победа"]);
  assert.equal(wl.querySelectorAll(".won").length, 0);
  assert.equal(wl.querySelector("a").getAttribute("href"), "/go/winline?game_pk=123");

  const rows = [...doc.querySelectorAll(".v26Goal")];
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /1-й\s*06:12/);
  assert.match(text(rows[0]), /Давид Пастрняк/);
  assert.match(text(rows[0]), /Передачи: Маршан, Макэвой/);
  assert.match(text(rows[0]), /0:1/);
  assert.match(text(rows[1]), /Travis Konecny/, "English fallback for a player without a Russian name");
  assert.match(text(rows[1]), /Без передач/);
  assert.match(text(rows[1]), /большинство/);
  assert.match(text(rows[2]), /в пустые ворота/);
  assert.ok(rows[0].querySelector("button.v26Play") && rows[1].querySelector("button.v26Play"), "ready clips have a play button");
  assert.ok(rows[2].querySelector(".v26Spin"), "clip being cut shows a spinner");
  assert.match(text(rows[2]), /Видео будет через 3–4 минуты/);
  assert.ok(!doc.querySelector("video"), "nothing plays until the user asks");
  const everything = text(doc.getElementById("v26Root"));
  assert.ok(!/Все голы матча|Концовка матча|Оригинал|Лёгкая/.test(everything), "no compilations and no choice of quality");
  assert.ok(!doc.querySelector("[data-special], [data-q], .v26Q"));

  // play the first goal inside the app: the 1080p app copy, no choice
  rows[0].querySelector(".v26Play").click();
  const video = doc.querySelector(".v26Player video");
  assert.ok(video, "player opens under the goal");
  assert.equal(video.getAttribute("src"), `${BASE}/tg/live/20261010/phi-bos/a.mp4`);
  assert.equal(video.getAttribute("poster"), `${BASE}/live/20261010/phi-bos/a.jpg`);
  assert.equal(video.__played, true, "playback starts from the tap");
  assert.equal(doc.querySelectorAll(".v26Player").length, 1);
  assert.ok(video.closest('[data-slot="405"]'), "player sits in the row of that goal");
  assert.ok(!doc.querySelector(".v26Q, [data-q]"), "no quality switch");
  video.dispatchEvent(new window.Event("error"));
  assert.match(text(doc.querySelector(".v26Err")), /Не удалось загрузить видео/);
  // another goal: one player at a time; this goal has no app copy yet, the original is the fallback
  doc.querySelector('[data-goal="407"] .v26Play').click();
  assert.equal(doc.querySelectorAll(".v26Player").length, 1);
  assert.equal(doc.querySelector('[data-slot="407"] video').getAttribute("src"), `${BASE}/live/20261010/phi-bos/b.mp4`);
  // tapping the same button closes it
  doc.querySelector('[data-goal="407"] .v26Play').click();
  assert.ok(!doc.querySelector("video"));

  // players and teams are clickable
  doc.querySelector('[data-goal="405"] .v26Link').click();
  assert.deepEqual(calls.player, [8477956]);
  doc.querySelector('[data-goal="405"] .v26Assist button').click();
  assert.deepEqual(calls.player, [8477956, 8473419]);
  doc.querySelector('[data-v26-team="BOS"]').click();
  assert.deepEqual(calls.team, ["BOS"]);

  // LIVE update: a new goal appears by itself, the open player is not interrupted
  doc.querySelector('[data-goal="405"] .v26Play').click();
  const openVideo = doc.querySelector(".v26Player video");
  const next = livePayload();
  next.state.label_ru = "3-й период · 19:40";
  next.teams.home.score = 3;
  next.goals.push({ ...next.goals[2], event_id: 415, time: "02:11", score_after: { away: 1, home: 3 }, period: { number: 3, type: "REG", label_ru: "3-й период", short_ru: "3-й" }, clip: { state: "pending" } });
  box.payload = next;
  await window.HOHV26.tick();
  assert.equal(doc.querySelectorAll(".v26Goal").length, 4, "new goal added without reloading the page");
  assert.match(text(doc.querySelector('[data-goal="415"]')), /новый гол/);
  assert.match(text(doc.querySelector(".v26Pill")), /3-й период · 19:40/);
  assert.equal(text(doc.querySelector(".v26Score")), "1 : 3");
  assert.equal(doc.querySelector(".v26Player video"), openVideo, "the same <video> element keeps playing");
  assert.ok(!/новый гол/.test(text(doc.querySelector('[data-goal="405"]'))));

  // a failed refresh keeps what is shown
  box.payload = null;
  await window.HOHV26.tick();
  assert.equal(doc.querySelectorAll(".v26Goal").length, 4, "failed refresh keeps the last good data");
  assert.ok(doc.querySelector("a.v26Cover"), "and the cover");

  // back button honours the caller
  doc.getElementById("v15Back").click();
  assert.equal(calls.back, 1);
  assert.equal(window.HOHV26.state.timer, null, "polling stops when leaving");
  window.close();
}

{
  // the cover: our copy, then the VK picture, then the logos with a VK button
  const noCopy = { ...livePayload(), cover_url: null };
  const { window, doc, H } = makeScreen({ payload: noCopy });
  await H.openGameV26(123, {});
  assert.equal(doc.querySelector("a.v26Cover img").getAttribute("src"), "/api/telegram-center-media/vk-cover?source_key=vk1", "no copy on our server yet: the VK picture");
  doc.querySelector("a.v26Cover img").dispatchEvent(new window.Event("error"));
  assert.ok(!doc.querySelector(".v26Cover"), "the picture is gone and nothing is retried in a loop");
  assert.equal(doc.querySelectorAll(".v26Team img").length, 2, "logos come back");
  assert.equal(doc.querySelector("a.v26Vk").dataset.link, VK, "and a plain button to the broadcast");
  window.close();
  const failing = makeScreen();
  await failing.H.openGameV26(123, {});
  failing.doc.querySelector("a.v26Cover img").dispatchEvent(new failing.window.Event("error"));
  assert.equal(failing.doc.querySelector("a.v26Cover img").getAttribute("src"), "/api/telegram-center-media/vk-cover?source_key=vk1", "our copy failed: the VK picture is next");
  failing.window.close();
  const noVk = makeScreen({ v19: { ...V19, broadcast: null }, payload: noCopy });
  await noVk.H.openGameV26(123, {});
  assert.ok(!noVk.doc.querySelector(".v26Cover, .v26Vk"), "no broadcast, no cover, no link");
  assert.equal(noVk.doc.querySelectorAll(".v26Team img").length, 2);
  noVk.window.close();
}

{
  // Winline panel after the game: the outcome that won on regulation time is orange
  const overtime = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "FINAL", period: { number: 4, periodType: "OT" }, away: 3, home: 2 }), index: INDEX, indexOk: true, names: NAMES, now: Date.parse("2026-10-12T00:00:00Z"), clipsBase: BASE });
  const { window, doc, H } = makeScreen({ payload: overtime });
  await H.openGameV26(123, {});
  const won = [...doc.querySelectorAll(".v26Wl .won")];
  assert.equal(won.length, 1);
  assert.match(text(won[0]), /Н.*4\.20/, "decided in overtime: the draw on regulation time won");
  window.close();

  const homeWin = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "OFF", away: 1, home: 2 }), index: INDEX, indexOk: true, names: NAMES, now: Date.parse("2026-10-12T00:00:00Z"), clipsBase: BASE });
  const home = makeScreen({ payload: homeWin });
  await home.H.openGameV26(123, {});
  assert.match(text(home.doc.querySelector(".v26Wl .won")), /BOS.*2\.20/, "the hosts won");
  home.window.close();

  // an older game: the closing line and its result come from the archive
  const archive = { ...V19, winline: null, historical_odds: { p1: 2.3, x: 4.3, p2: 2.6, result: "2" } };
  const old = makeScreen({ v19: archive, payload: { ...homeWin, result: null } });
  await old.H.openGameV26(123, {});
  assert.deepEqual([...old.doc.querySelectorAll(".v26Wl .v26Odd b")].map(text), ["2.60", "4.30", "2.30"]);
  assert.match(text(old.doc.querySelector(".v26Wl .won")), /PHI.*2\.60/, "the guests won");
  old.window.close();

  // no-spoilers hides the winner too
  const quiet = makeScreen({ payload: homeWin });
  quiet.window.HOHNoSpoilers = () => true;
  await quiet.H.openGameV26(123, {});
  assert.equal(quiet.doc.querySelectorAll(".v26Wl .won").length, 0, "the winner is a spoiler");
  assert.equal(quiet.doc.querySelectorAll(".v26Wl .v26Odd").length, 3, "the line itself stays");
  quiet.doc.querySelector("[data-reveal]").click();
  assert.equal(quiet.doc.querySelectorAll(".v26Wl .won").length, 1);
  quiet.window.close();

  // no line at all: no panel
  const bare = makeScreen({ v19: { ...V19, winline: null } });
  await bare.H.openGameV26(123, {});
  assert.ok(!bare.doc.querySelector(".v26Wl"));
  bare.window.close();
}

{
  // a goal without any video: the play button is there but not active
  const old = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "OFF" }), index: INDEX, indexOk: true, names: NAMES, now: Date.parse("2026-10-12T00:00:00Z"), clipsBase: BASE });
  const { window, doc, H } = makeScreen({ payload: old });
  await H.openGameV26(123, {});
  const off = doc.querySelector('[data-goal="410"] .v26Play');
  assert.ok(off.classList.contains("off"));
  assert.equal(off.tagName, "SPAN", "not a button: nothing to press");
  assert.equal(off.getAttribute("aria-disabled"), "true");
  off.click();
  assert.ok(!doc.querySelector("video"), "pressing it does nothing");
  window.close();
}

{
  // opening a player or a team from the match: their back button leads to this match, not to the list
  const { window, calls, doc, H } = makeScreen();
  H.openPlayer = (id) => { calls.player.push(id); };
  await H.openGameV26(123, { returnTab: "games" });
  assert.equal(H.state.returnTo, null, "nothing to return to while the match is the first screen");
  doc.querySelector('[data-goal="405"] .v26Link').click();
  assert.equal(typeof H.state.returnTo, "function", "the match leaves a way back before the player page opens");
  assert.equal(window.HOHV26.state.timer, null, "polling is paused while another page is open");
  doc.getElementById("view").innerHTML = "<div>player page</div>";
  await H.state.returnTo();
  assert.ok(doc.querySelector(".v26Match"), "the match screen is shown again");
  assert.equal(doc.querySelectorAll(".v26Goal").length, 3, "with its goals");
  assert.equal(H.state.returnTo, null, "the way back is used once");
  assert.equal(calls.back, 0, "the list was never asked to take over");
  // teams work the same way, and the match's own back button clears a stale hook before following the original caller
  doc.querySelector('[data-v26-team="BOS"]').click();
  assert.equal(typeof H.state.returnTo, "function");
  await H.state.returnTo();
  doc.getElementById("v15Back").click();
  assert.equal(H.state.returnTo, null);
  assert.equal(calls.back, 1, "back from the match itself still goes to the list");
  window.close();
}

{
  // the shared back function of the app honours the return hook and keeps its old behaviour without one
  const { handleTelegramCenterV15CoreUi } = await import("../cloudflare-worker/src/telegram-center-v15-core-ui.js");
  const core = await handleTelegramCenterV15CoreUi(new Request("https://example.test/telegram-app/v15-core.js"), "/telegram-app/v15-core.js").text();
  const match = /V15\.goBack=function\(\)\{[^\n]*?\};\n/.exec(core);
  assert.ok(match, "V15.goBack is present in the core layer");
  const dom = new JSDOM('<!doctype html><body><nav id="tabs" style="display:none"><button class="tab" data-tab="games"></button><button class="tab" data-tab="players"></button></nav><main id="view"></main></body>', { url: "https://hoh.example.test/", runScripts: "outside-only" });
  const { window } = dom;
  const clicked = [];
  window.document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => clicked.push(b.dataset.tab)));
  window.eval(`var run=function(){};var V15={state:{profile:true,returnTab:"players"}};${match[0]}window.__V15=V15;`);
  const V15 = window.__V15;
  V15.goBack();
  assert.deepEqual(clicked, ["players"], "without a hook the old behaviour is kept: go to the tab the person came from");
  assert.equal(V15.state.profile, false);
  assert.equal(window.document.getElementById("tabs").style.display, "grid");
  let hook = 0;
  V15.state.profile = true;
  V15.state.returnTo = () => { hook += 1; };
  V15.goBack();
  assert.equal(hook, 1, "the hook runs");
  assert.deepEqual(clicked, ["players"], "and the tab list is not touched");
  assert.equal(V15.state.returnTo, null, "the hook is used once");
  assert.equal(V15.state.profile, true, "the person stays on a profile-style page");
  V15.goBack();
  assert.deepEqual(clicked, ["players", "players"], "the next back press behaves as before");
  window.close();
}

{
  // no-spoilers: score and goals stay hidden until the user asks
  const { window, doc, H } = makeScreen();
  window.HOHNoSpoilers = () => true;
  await H.openGameV26(123, {});
  assert.equal(text(doc.querySelector(".v26Score")), "• : •");
  assert.ok(!doc.querySelector(".v26Shots"));
  assert.ok(!doc.querySelector(".v26Goal"));
  assert.match(text(doc.querySelector(".v26Note")), /без спойлеров/);
  doc.querySelector("[data-reveal]").click();
  assert.equal(doc.querySelectorAll(".v26Goal").length, 3);
  assert.equal(text(doc.querySelector(".v26Score")), "1 : 2");
  window.close();
}

{
  // upcoming game
  const upcoming = buildGoalsPayload({ gamePk: 123, landing: { gameState: "FUT", startTimeUTC: "2026-10-10T17:00:00Z", awayTeam: { abbrev: "PHI" }, homeTeam: { abbrev: "BOS" } }, now: NOW, clipsBase: BASE });
  const { window, doc, H } = makeScreen({ v19: { ...V19, game: { ...V19.game, game_state: "FUT" } }, payload: upcoming });
  await H.openGameV26(123, {});
  assert.ok(!doc.querySelector(".v26Pill.live"));
  assert.equal(text(doc.querySelector(".v26Score")), "—");
  assert.match(text(doc.querySelector(".v26Note")), /Матч ещё не начался/);
  assert.equal(doc.querySelectorAll(".v26Wl .v26Odd b").length, 3, "the line is shown before the game");
  assert.equal(doc.querySelectorAll(".won").length, 0);
  assert.equal(window.HOHV26.state.timer, null, "no polling before the game");
  window.close();
}

{
  // clip server down: goals still shown, clear message, no active play buttons
  const down = buildGoalsPayload({ gamePk: 123, landing: landing(), index: null, indexOk: false, names: NAMES, now: NOW, clipsBase: BASE });
  const { window, doc, H } = makeScreen({ payload: down });
  await H.openGameV26(123, {});
  assert.equal(doc.querySelectorAll(".v26Goal").length, 3);
  assert.match(text(doc.querySelector(".v26List")), /Видео временно недоступно/);
  assert.ok(!doc.querySelector("button.v26Play"));
  window.close();
}

{
  // goals feed down at open time: header + retry; a failing game request throws so the classic page can take over
  const { window, doc, box, H } = makeScreen({ payload: null });
  await H.openGameV26(123, {});
  assert.match(text(doc.querySelector(".v26Note")), /Голы временно недоступны/);
  box.payload = livePayload();
  doc.querySelector("[data-retry]").click();
  await settle();
  assert.equal(doc.querySelectorAll(".v26Goal").length, 3, "retry loads the goals");
  window.close();
  const broken = makeScreen({ v19: null });
  await assert.rejects(() => broken.H.openGameV26(123, {}), /HTTP 500|game_not_found/, "game failure throws so the old page can take over");
  broken.window.close();
}

// ---- 5) the classic openGame hands over to the new screen and falls back to itself ---------------------------------------------
{
  const v19js = await (await handleTelegramCenterV19Ui(new Request("https://x.test/v19"), "/telegram-app/v19.js")).text();
  const run = (v26) => {
    const dom = new JSDOM('<!doctype html><body><nav id="tabs"></nav><main id="view"></main></body>', { url: "https://hoh.example.test/", pretendToBeVisual: true, runScripts: "outside-only" });
    const { window } = dom;
    const apiCalls = [];
    window.HOHV15 = {
      esc: (v) => String(v ?? ""), state: {}, currentTab: () => "games", tabsVisible: () => true, view: () => window.document.getElementById("view"),
      backRow: () => '<button id="v15Back"></button>', goBack() {}, api: async (url) => { apiCalls.push(url); return { game: null, error: "classic_page_ran" }; }, V2: "/v2", teamLogo: () => "",
    };
    if (v26) window.HOHV15.openGameV26 = v26;
    window.Telegram = { WebApp: {} };
    window.eval(v19js);
    return { window, apiCalls };
  };
  const seen = [];
  const handed = run(async (pk, ctx) => { seen.push([pk, ctx]); });
  await handed.window.HOHV15.openGameV19(77, { returnTab: "games" });
  assert.deepEqual(seen, [[77, { returnTab: "games" }]], "classic openGame hands over to the new screen");
  assert.ok(!handed.apiCalls.some((u) => u.includes("/games/77")), "the classic page did not run");
  const fallback = run(async () => { throw new Error("boom"); });
  await fallback.window.HOHV15.openGameV19(78, {});
  assert.ok(fallback.apiCalls.some((u) => u.includes("/games/78")), "new screen failed: the classic page runs");
  const classic = run(null);
  await classic.window.HOHV15.openGameV19(79, {});
  assert.ok(classic.apiCalls.some((u) => u.includes("/games/79")), "without the new screen nothing changes");
  for (const x of [handed, fallback, classic]) x.window.close();
}

// ---- 6) every goal of one player in the season ------------------------------------------------------------------------------
const gameLanding = (pk, start, away, home, goals) => ({
  id: pk, gameState: "OFF", startTimeUTC: start, periodDescriptor: { number: 3, periodType: "REG" },
  awayTeam: { abbrev: away, score: 2, sog: 20 }, homeTeam: { abbrev: home, score: 3, sog: 25 },
  summary: { scoring: [{ periodDescriptor: { number: 1, periodType: "REG" }, goals }, { periodDescriptor: { number: 3, periodType: "REG" }, goals: [] }] },
});
const PLAYER = 8478398;
const PIDX = {
  version: 1,
  games: [
    { game_pk: 2026020201, date: "20261006", kind: "live", away: "PHI", home: "BOS", goals: [
      { event_id: 11, scorer_id: PLAYER, away_score: 1, home_score: 0, ...clip("live/20261006/phi-bos/a.mp4") },
    ] },
  ],
  covers: {},
};
const SEASON_LOG = [
  { gameId: 2026020201, gameDate: "2026-10-06", goals: 2, opponentAbbrev: "BOS" },
  { gameId: 2026020150, gameDate: "2026-10-04", goals: 1, opponentAbbrev: "NYR" },
  { gameId: 2026020100, gameDate: "2026-10-02", goals: 1, opponentAbbrev: "TOR" },
  { gameId: 2026020120, gameDate: "2026-10-03", goals: 0, opponentAbbrev: "OTT" },
  { gameId: 2026020175, gameDate: "2026-10-05", goals: 1, opponentAbbrev: "DET" },
];
const SEASON_LANDINGS = new Map([
  [2026020201, gameLanding(2026020201, "2026-10-06T23:00:00Z", "PHI", "BOS", [
    goal(11, PLAYER, "PHI", false, "Travis", "Konecny", "04:10", 1, 0),
    goal(12, PLAYER, "PHI", false, "Travis", "Konecny", "17:30", 2, 1, { strength: "pp" }),
  ])],
  [2026020150, gameLanding(2026020150, "2026-10-04T23:00:00Z", "NYR", "PHI", [goal(21, PLAYER, "PHI", true, "Travis", "Konecny", "09:00", 0, 1, { goalModifier: "empty-net" })])],
  [2026020100, gameLanding(2026020100, "2026-10-02T23:00:00Z", "PHI", "TOR", [goal(31, PLAYER, "PHI", false, "Travis", "Konecny", "02:02", 1, 0)])],
]);
{
  const payload = buildPlayerSeasonPayload({ playerId: PLAYER, names: { nameEn: "Travis Konecny", nameRu: "Тревор Конечни" }, season: "20262027", log: SEASON_LOG, landings: SEASON_LANDINGS, index: PIDX, indexOk: true, clipsBase: BASE, now: NOW });
  assert.equal(payload.version, 2);
  assert.equal(payload.season, "20262027");
  assert.equal(payload.total, 5, "all goals of the season: 2 + 1 + 1 + 1 (one game could not be loaded)");
  assert.equal(payload.listed, 4);
  assert.equal(payload.missing, 1, "a game whose feed failed is counted, not hidden");
  assert.equal(payload.with_video, 1, "one of the listed goals has a clip");
  assert.equal(payload.games, 3);
  assert.deepEqual(payload.goals.map((g) => [g.game_pk, g.event_id]), [[2026020201, 11], [2026020201, 12], [2026020150, 21], [2026020100, 31]], "newest game first, goals in game order");
  const [first, second, third] = payload.goals;
  assert.equal(first.date, "2026-10-06");
  assert.equal(first.away, "PHI");
  assert.equal(first.home, "BOS");
  assert.equal(first.opponent, "BOS");
  assert.equal(first.clip.state, "ready");
  assert.equal(first.clip.url, `${BASE}/tg/live/20261006/phi-bos/a.mp4`);
  assert.equal(second.clip.state, "none", "same game, second goal: no clip");
  assert.equal(second.strength_label_ru, "большинство");
  assert.equal(third.modifier_label_ru, "в пустые ворота");
  assert.deepEqual(first.score_after, { away: 1, home: 0 });
  assert.equal(first.period.short_ru, "1-й");
  assert.equal(first.time, "04:10", "time is elapsed time from the NHL feed");
  assert.equal(payload.player.name_ru, "Тревор Конечни");
  const withoutServer = buildPlayerSeasonPayload({ playerId: PLAYER, season: "20262027", log: SEASON_LOG, landings: SEASON_LANDINGS, index: null, indexOk: false, clipsBase: BASE, now: NOW });
  assert.deepEqual([withoutServer.server_ok, withoutServer.with_video, withoutServer.listed], [false, 0, 4], "clip server down: the goals are all there");
  const noGoals = buildPlayerSeasonPayload({ playerId: 5, season: "20262027", log: [{ gameId: 1, gameDate: "2026-10-01", goals: 0 }], landings: new Map(), index: PIDX, indexOk: true, clipsBase: BASE, now: NOW });
  assert.deepEqual([noGoals.total, noGoals.goals.length, noGoals.missing], [0, 0, 0]);
  const pending = buildPlayerSeasonPayload({ playerId: PLAYER, season: "20262027", log: SEASON_LOG, landings: SEASON_LANDINGS, index: PIDX, indexOk: true, clipsBase: BASE, now: Date.parse("2026-10-06T23:50:00Z") });
  assert.equal(pending.goals[1].clip.state, "pending", "a game that has just finished: the clip is still being cut");
  assert.equal(seasonIdOf(Date.parse("2026-10-10T12:00:00Z")), "20262027");
  assert.equal(seasonIdOf(Date.parse("2027-04-20T12:00:00Z")), "20262027");
  assert.equal(seasonIdOf(Date.parse("2026-07-01T12:00:00Z")), "20252026");
  assert.equal(seasonIdOf(Date.parse("2026-09-15T12:00:00Z")), "20262027");
}
{
  // route: the NHL game log + the landing feed of each game where the player scored
  const fetched = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    const season = seasonIdOf(Date.now());
    if (u === `https://api-web.nhle.com/v1/player/${PLAYER}/game-log/${season}/2`) return new Response(JSON.stringify({ gameLog: SEASON_LOG }), { status: 200 });
    if (u === `https://api-web.nhle.com/v1/player/${PLAYER}/game-log/${season}/3`) return new Response(JSON.stringify({ gameLog: [] }), { status: 200 });
    const m = /gamecenter\/(\d+)\/landing/.exec(u);
    if (m) return SEASON_LANDINGS.has(Number(m[1])) ? new Response(JSON.stringify(SEASON_LANDINGS.get(Number(m[1]))), { status: 200 }) : new Response("no", { status: 404 });
    if (u.endsWith("/index.json")) return new Response(JSON.stringify(PIDX), { status: 200 });
    return new Response("unexpected " + u, { status: 500 });
  };
  const db = { prepare: () => ({ bind: (id) => ({ first: async () => (id === PLAYER ? { full_name_en: "Travis Konecny", full_name_ru: "Тревор Конечни" } : null) }) }) };
  const env = { DB: db, HOH_CLIPS_BASE: BASE };
  const path = `/api/telegram-center-v26/players/${PLAYER}/goals`;
  const ok = await handleTelegramCenterV26(new Request("https://x.test" + path), env, path);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.equal(body.player.name_ru, "Тревор Конечни", "player name comes from the players table");
  assert.equal(body.total, 5);
  assert.equal(body.listed, 4);
  assert.equal(body.with_video, 1);
  assert.equal(fetched.filter((u) => u.includes("/landing")).length, 4, "a landing feed is read only for games where the player scored");
  assert.ok(!fetched.some((u) => u.includes("/2026020120/")), "no goals, no request");
  assert.equal((await handleTelegramCenterV26(new Request("https://x.test/a", { method: "POST" }), env, path)).status, 405);
  assert.equal(await handleTelegramCenterV26(new Request("https://x.test/a"), env, "/api/telegram-center-v26/players/abc/goals"), null, "only numeric ids are routed");
  globalThis.fetch = async (url) => (String(url).includes("game-log") ? new Response("no", { status: 503 }) : new Response("no", { status: 502 }));
  const down = await handleTelegramCenterV26(new Request("https://x.test" + path), env, path);
  assert.equal(down.status, 502, "NHL game log down: a clear error instead of an empty list");
  assert.equal((await down.json()).error, "nhl_unavailable");
  globalThis.fetch = realFetch;
}
{
  // route: the cover keeper on the highlights server asks which broadcasts have a cover to save
  const rows = [{ game_pk: 2026020069, game_state: "OFF", scheduled_start_utc: "2026-10-10T02:00:00Z", source_key: "vk_a", thumbnail_url: "https://sun9-77.userapi.com/s/v1/ig2/a.jpg?size=1280x720" }];
  let sql = "";
  let args = [];
  const env = { DB: { prepare: (q) => { sql = q; return { bind: (...a) => { args = a; return { all: async () => ({ results: rows }) }; } }; } } };
  const path = "/api/telegram-center-v26/covers/wanted";
  const ok = await handleTelegramCenterV26(new Request("https://x.test" + path), env, path);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, games: [{ game_pk: 2026020069, source_key: "vk_a", state: "OFF", start: "2026-10-10T02:00:00Z", thumbnail_url: "https://sun9-77.userapi.com/s/v1/ig2/a.jpg?size=1280x720" }], next: null }, "with the picture address: the keeper in Moscow takes it from VK directly (Frankfurt cannot)");
  assert.equal(directCover("https://iv.okcdn.ru/getVideoPreview?id=1"), null, "never the dead preview link");
  assert.equal(directCover("https://evil.test/a.jpg"), null, "VK pictures only");
  assert.equal(directCover("http://sun9-1.userapi.com/a.jpg"), null, "https only");
  assert.equal(directCover("https://sun9-82.vkuserphoto.ru/impg/x.jpg"), "https://sun9-82.vkuserphoto.ru/impg/x.jpg");
  assert.match(sql, /game_vk_broadcasts/);
  assert.match(sql, /thumbnail_url IS NOT NULL/);
  assert.equal(args.length, 5, "the window and the page size are bound, not pasted into the query");
  assert.equal(args[4], 80, "default page size");
  const day = 24 * 3600 * 1000;
  assert.ok(Date.parse(args[0]) < Date.now() - 3 * day && Date.parse(args[0]) > Date.now() - 5 * day, "by default: from four days back");
  assert.ok(Date.parse(args[1]) > Date.now() + day, "to two days ahead");

  // the archive walk: since + limit, newest first, a cursor for the next page
  const page = Array.from({ length: 3 }, (_, i) => ({ game_pk: 2026020300 - i, game_state: "OFF", scheduled_start_utc: "2026-10-06T23:00:00Z", source_key: `vk_${i}` }));
  rows.splice(0, rows.length, ...page);
  const first = await (await handleTelegramCenterV26(new Request(`https://x.test${path}?since=2024-09-01&limit=3`), env, path)).json();
  assert.equal(args[0], "2024-09-01T00:00:00Z");
  assert.equal(args[4], 3);
  assert.equal(first.games.length, 3);
  assert.equal(first.next, "2026-10-06T23:00:00Z|2026020298", "a full page hands out a cursor (start time and game id: many games start together)");
  await handleTelegramCenterV26(new Request(`https://x.test${path}?since=2024-09-01&limit=3&before=${encodeURIComponent(first.next)}`), env, path);
  assert.deepEqual(args.slice(1, 4), ["2026-10-06T23:00:00Z", "2026-10-06T23:00:00Z", 2026020298], "the next page starts right after the cursor");
  rows.splice(0, rows.length, page[0]);
  assert.equal((await (await handleTelegramCenterV26(new Request(`https://x.test${path}?since=2024-09-01&limit=3`), env, path)).json()).next, null, "a short page is the last one");
  await handleTelegramCenterV26(new Request(`https://x.test${path}?since=2020-01-01&limit=9999`), env, path);
  assert.equal(args[0], "2024-01-01T00:00:00Z", "nothing before the archive starts");
  assert.equal(args[4], 200, "a page is at most 200 games");
  for (const bad of ["since=yesterday", "since=2024-13-45", "since=2024-09-01&before=x", "before=2026-10-06T23:00:00Z%7C1%27%3B"]) {
    const res = await handleTelegramCenterV26(new Request(`https://x.test${path}?${bad}`), env, path);
    assert.equal(res.status, 400, `bad parameter refused: ${bad}`);
  }
  assert.equal((await handleTelegramCenterV26(new Request("https://x.test" + path, { method: "POST" }), env, path)).status, 405);
  assert.equal((await handleTelegramCenterV26(new Request("https://x.test" + path), {}, path)).status, 503, "no database: a clear error");
}

function makeProfile({ payload, fail = false } = {}) {
  const made = makeScreen();
  const { window, doc, H } = made;
  const api = H.api;
  const seen = [];
  H.api = async (url) => {
    if (url.includes("/api/telegram-center-v26/players/")) {
      seen.push(url);
      if (fail) throw new Error("HTTP 500");
      return payload;
    }
    return api(url);
  };
  const rendered = [];
  const profileHtml = '<div class="v15Profile v23PlayerProfile"><h1>Игрок</h1><button class="v23AllStatsBtn" id="v23AllStats">Вся статистика игрока</button><div class="v23Trend">тренд</div></div>';
  window.HOHV23 = {
    current: { p: { player_id: PLAYER, full_name_ru: "Тревор Конечни" } },
    renderMain: (ctx) => { rendered.push(ctx); doc.getElementById("view").innerHTML = profileHtml; },
  };
  const render = () => { doc.getElementById("view").innerHTML = profileHtml; };
  return { ...made, seen, rendered, render };
}
{
  const payload = buildPlayerSeasonPayload({ playerId: PLAYER, names: { nameEn: "Travis Konecny", nameRu: "Тревор Конечни" }, season: "20262027", log: SEASON_LOG, landings: SEASON_LANDINGS, index: PIDX, indexOk: true, clipsBase: BASE, now: NOW });
  const { window, doc, seen, rendered, render } = makeProfile({ payload });
  render();
  await settle();
  const button = doc.querySelector(".v26PgBtn");
  assert.ok(button, "the player profile gets a goals button after it is drawn");
  assert.equal(button.previousElementSibling.id, "v23AllStats", "right under the full statistics button");
  assert.equal(doc.querySelectorAll(".v26PgBtn").length, 1);
  render();
  await settle();
  assert.equal(doc.querySelectorAll(".v26PgBtn").length, 1, "re-rendering the profile does not stack buttons");
  // the player page of 2026-10-19 has «Все голы игрока» among its three buttons: no second one
  doc.getElementById("view").innerHTML = '<div class="v15Profile v23PlayerProfile"><nav class="v23Nav"><button class="v23NavBtn" data-v23-open="goals">Все голы игрока</button><button class="v23NavBtn" id="v23AllStats" data-v23-open="stats">Вся статистика игрока</button></nav></div>';
  await settle();
  assert.equal(doc.querySelectorAll(".v26PgBtn").length, 0, "the three buttons of the player page: nothing added");
  render();
  await settle();

  doc.querySelector(".v26PgBtn").click();
  await settle();
  assert.deepEqual(seen, [`/api/telegram-center-v26/players/${PLAYER}/goals`]);
  assert.ok(doc.getElementById("v26PgRoot").classList.contains("v15Profile"), "profile marker for the eye and gear row");
  assert.match(text(doc.querySelector("#v26PgHero")), /Тревор Конечни/);
  assert.match(text(doc.querySelector("#v26PgHero")), /Сезон 2026\/27: 5 голов · с видео: 1/, "every goal of the season, not only those with video");
  assert.deepEqual([...doc.querySelectorAll(".v26GameHead span")].map(text), ["6 октября", "4 октября", "2 октября"]);
  assert.deepEqual([...doc.querySelectorAll(".v26GameHead b")].map(text), ["PHI — BOS", "NYR — PHI", "PHI — TOR"]);
  const rows = [...doc.querySelectorAll("[data-pg-goal]")];
  assert.equal(rows.length, 4);
  assert.match(text(rows[0]), /1-й\s*04:10/);
  assert.match(text(rows[0]), /PHI.*в гостях.*Счёт после гола 1:0/);
  assert.match(text(rows[1]), /большинство/);
  assert.match(text(rows[2]), /дома.*в пустые ворота/);
  assert.ok(!/\sdata-(player|team|tab)=/.test(doc.getElementById("v26PgRoot").innerHTML), "no attributes that the global handlers swallow");
  assert.ok(!doc.querySelector(".v26Q, [data-q], [data-pg-q]"), "no choice of quality");
  assert.match(text(doc.querySelector(".v26Note")), /Не удалось загрузить подробности 1 гола/, "an incomplete list says so");

  // goals with video play; goals without video have a grey, inactive play button
  assert.equal(doc.querySelectorAll("button.v26Play").length, 1);
  assert.equal(doc.querySelectorAll(".v26Play.off").length, 3);
  assert.equal(doc.querySelectorAll(".v26Play.off")[0].getAttribute("aria-disabled"), "true");
  doc.querySelector(".v26Play.off").click();
  assert.ok(!doc.querySelector("video"), "an inactive button does nothing");
  rows[0].querySelector(".v26Play").click();
  const video = doc.querySelector(".v26Player video");
  assert.equal(video.getAttribute("src"), `${BASE}/tg/live/20261006/phi-bos/a.mp4`);
  assert.equal(video.__played, true);
  assert.ok(video.closest('[data-pg-slot="2026020201:11"]'));
  rows[0].querySelector(".v26Play").click();
  assert.ok(!doc.querySelector("video"), "tapping again closes it");

  // a game header opens the match, and the match's back button returns to this list
  doc.querySelector('[data-pg-game="2026020150"]').click();
  await settle();
  assert.ok(doc.getElementById("v26Root") && !doc.getElementById("v26PgRoot"), "the match screen is open");
  doc.getElementById("v15Back").click();
  await settle();
  assert.ok(doc.getElementById("v26PgRoot"), "back from the match returns to the player's goals");
  assert.equal(doc.querySelectorAll("[data-pg-goal]").length, 4);

  // back from the list returns to the profile without reloading it
  doc.getElementById("v15Back").click();
  assert.equal(rendered.length, 1, "the profile layer redraws the profile it already holds");
  assert.equal(rendered[0], window.HOHV23.current);
  await settle();
  assert.equal(doc.querySelectorAll(".v26PgBtn").length, 1, "and the goals button comes back with it");
  window.close();
}
{
  // no goals yet, spoilers hidden, failures: every state says something understandable
  const empty = buildPlayerSeasonPayload({ playerId: 5, season: "20262027", log: [{ gameId: 1, gameDate: "2026-10-01", goals: 0 }], landings: new Map(), index: PIDX, indexOk: true, clipsBase: BASE, now: NOW });
  const a = makeProfile({ payload: empty });
  a.render(); await settle();
  a.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.match(text(a.doc.querySelector("#v26PgBody")), /В этом сезоне голов пока нет/);
  assert.match(text(a.doc.querySelector("#v26PgHero")), /Сезон 2026\/27: 0 голов/);
  a.window.close();

  const payload = buildPlayerSeasonPayload({ playerId: PLAYER, season: "20262027", log: SEASON_LOG, landings: SEASON_LANDINGS, index: PIDX, indexOk: true, clipsBase: BASE, now: NOW });
  const b = makeProfile({ payload });
  b.window.HOHNoSpoilers = () => true;
  b.render(); await settle();
  b.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.ok(!b.doc.querySelector("[data-pg-goal]"), "goals are hidden in no-spoilers mode");
  assert.ok(!/Сезон 2026/.test(text(b.doc.querySelector("#v26PgHero"))), "and so is the count");
  b.doc.querySelector("[data-pg-reveal]").click();
  assert.equal(b.doc.querySelectorAll("[data-pg-goal]").length, 4);
  b.window.close();

  const c = makeProfile({ payload: null, fail: true });
  c.render(); await settle();
  c.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.match(text(c.doc.querySelector("#v26PgBody")), /Голы игрока временно недоступны/);
  assert.ok(c.doc.querySelector("[data-pg-retry]"));
  c.window.close();

  const d = makeProfile({ payload: buildPlayerSeasonPayload({ playerId: PLAYER, season: "20262027", log: SEASON_LOG, landings: SEASON_LANDINGS, index: null, indexOk: false, clipsBase: BASE, now: NOW }) });
  d.render(); await settle();
  d.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.match(text(d.doc.querySelector("#v26PgBody")), /Видео временно недоступно, голы показаны без роликов/);
  assert.equal(d.doc.querySelectorAll("[data-pg-goal]").length, 4, "all goals are listed even without the clip server");
  assert.ok(!d.doc.querySelector("button.v26Play"));
  d.window.close();
}

console.log("GOALS_SCREEN_OK");
process.exit(0);
