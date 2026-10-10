// Live Center match screen: goals with scorers/assists, clips played inside the app, LIVE updates, no-spoilers.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildGoalsPayload, buildPlayerGoalsPayload, playerIdsOf, periodInfo, phaseOf } from "../cloudflare-worker/src/telegram-center-v26-goals-data.js";
import { handleTelegramCenterV26, FONT_CSS, FONT_PRELOAD_LINKS } from "../cloudflare-worker/src/telegram-center-v26-goals.js";
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
function landing({ state = "LIVE", period = { number: 2, periodType: "REG" }, start = "2026-10-10T17:00:00Z", clock = { timeRemaining: "14:32", running: true, inIntermission: false } } = {}) {
  return {
    id: 123, gameState: state, startTimeUTC: start, periodDescriptor: period, clock,
    awayTeam: { abbrev: "PHI", score: 1, sog: 18 }, homeTeam: { abbrev: "BOS", score: 2, sog: 24 },
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
      ],
      all_goals: clip("live/20261010/phi-bos/ALL.mp4"), ending: { ...clip("live/20261010/phi-bos/FIN.mp4"), kind: "final_horn" } },
    { game_pk: 123, date: "20261008", kind: "vod", away: "PHI", home: "BOS", goals: [] },
  ],
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
  assert.equal(g1.clip.state, "ready");
  assert.equal(g1.clip.orig_url, `${BASE}/live/20261010/phi-bos/a.mp4`);
  assert.equal(g1.clip.light_url, `${BASE}/tg/live/20261010/phi-bos/a.mp4`);
  assert.equal(g1.clip.poster_url, `${BASE}/live/20261010/phi-bos/a.jpg`);
  assert.equal(g2.strength_label_ru, "большинство");
  assert.equal(g2.scorer.name_ru, null, "unknown player falls back to the English name on screen");
  assert.equal(g2.clip.light_url, null);
  assert.equal(g3.modifier_label_ru, "в пустые ворота");
  assert.equal(g3.clip.state, "pending", "live game, clip not cut yet");
  assert.equal(p.clips.ready, 2);
  assert.equal(p.clips.all_goals.orig_url, `${BASE}/live/20261010/phi-bos/ALL.mp4`);
  assert.equal(p.clips.ending.kind, "final_horn");
  assert.deepEqual(playerIdsOf(landing()).sort(), [8473419, 8477956, 8478398, 8480727]);

  const noServer = buildGoalsPayload({ gamePk: 123, landing: landing(), index: null, indexOk: false, now: NOW, clipsBase: BASE });
  assert.ok(noServer.goals.every((g) => g.clip.state === "none"), "server down: no fake 'pending' spinners");
  assert.equal(noServer.clips.server_ok, false);

  const finalRecent = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "OFF", clock: { timeRemaining: "00:00" } }), index: INDEX, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(finalRecent.state.label_ru, "Финал");
  assert.equal(finalRecent.goals[2].clip.state, "pending", "just finished: the last clip is still being cut");
  const finalOld = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "OFF" }), index: INDEX, indexOk: true, now: Date.parse("2026-10-11T12:00:00Z"), clipsBase: BASE });
  assert.equal(finalOld.goals[2].clip.state, "none", "long after the game there is no clip to wait for");
  const otFinal = buildGoalsPayload({ gamePk: 123, landing: landing({ state: "FINAL", period: { number: 4, periodType: "OT" } }), index: INDEX, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(otFinal.state.label_ru, "Финал · ОТ");
  const unknownGame = buildGoalsPayload({ gamePk: 999, landing: landing(), index: INDEX, indexOk: true, now: NOW, clipsBase: BASE });
  assert.equal(unknownGame.clips.available, false);
  assert.equal(periodInfo({ number: 6, periodType: "OT" }).label_ru, "3-й овертайм");
  assert.equal(phaseOf("CRIT"), "live");
  assert.equal(buildGoalsPayload({ gamePk: 123, landing: { gameState: "FUT", startTimeUTC: "2026-10-11T00:00:00Z", awayTeam: { abbrev: "AAA" }, homeTeam: { abbrev: "BBB" } }, now: NOW }).goals.length, 0);
}

// ---- 2) routes ------------------------------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
function stubFetch({ landingOk = true, indexOk = true } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api-web.nhle.com")) return landingOk ? new Response(JSON.stringify(landing()), { status: 200 }) : new Response("no", { status: 503 });
    if (u.endsWith("/index.json")) return indexOk ? new Response(JSON.stringify(INDEX), { status: 200 }) : new Response("no", { status: 502 });
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
  assert.equal(body.goals[0].clip.orig_url, `${BASE}/live/20261010/phi-bos/a.mp4`);
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
const V19 = {
  game: { game_pk: 123, game_state: "LIVE", scheduled_start_utc: "2026-10-10T17:00:00Z", venue_name: "TD Garden", away_score: 1, home_score: 2,
    away: { tri: "PHI", name_ru: "Филадельфия Флайерз", logo: "https://l.example.test/PHI.svg" }, home: { tri: "BOS", name_ru: "Бостон Брюинз", logo: "https://l.example.test/BOS.svg" } },
  winline: { markets: [{ outcome_key: "home", odds: 2.2 }, { outcome_key: "draw", odds: 4.2 }, { outcome_key: "away", odds: 2.75 }] },
  broadcast: { web_url: "https://vkvideo.ru/video-1_2" },
};
const livePayload = () => buildGoalsPayload({ gamePk: 123, landing: landing(), index: INDEX, indexOk: true, names: NAMES, now: NOW, clipsBase: BASE });

function makeScreen({ v19 = V19, payload = livePayload() } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav id="tabs"></nav><main id="view"></main></body>', { url: "https://hoh.example.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLMediaElement.prototype.play = function play() { this.__played = true; return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  window.HTMLMediaElement.prototype.load = function load() {};
  const calls = { api: [], player: [], team: [], back: 0 };
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
  assert.ok(doc.querySelector(".v26Pill.live"), "LIVE badge");
  assert.match(text(doc.querySelector(".v26Pill")), /LIVE · 2-й период · 14:32/);
  assert.equal(text(doc.querySelector(".v26Score")), "1 : 2");
  assert.match(text(doc.querySelector(".v26Shots")), /Броски 18 : 24/);
  assert.deepEqual([...doc.querySelectorAll(".v26Team b")].map(text), ["PHI", "BOS"]);
  // the base layers (v7, v15-player, v15-team, v17) listen to every click on [data-player], [data-team] and [data-tab] across the whole
  // document and open their own pages before this screen can react; the screen must use its own attribute names.
  assert.ok(!/\sdata-(player|team|tab)=/.test(doc.getElementById("v26Root").innerHTML), "no attributes that the global handlers swallow");

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
  assert.ok(rows[0].querySelector(".v26Play") && rows[1].querySelector(".v26Play"), "ready clips have a play button");
  assert.ok(rows[2].querySelector(".v26Spin"), "clip being cut shows a spinner");
  assert.match(text(rows[2]), /Видео будет через 3–4 минуты/);
  assert.ok(!doc.querySelector("video"), "nothing plays until the user asks");
  assert.match(text(doc.querySelector(".v26List")), /Все голы матча одним роликом/);
  assert.match(text(doc.querySelector(".v26List")), /Концовка матча/);

  // play the first goal inside the app: the light version by default, always
  rows[0].querySelector(".v26Play").click();
  let video = doc.querySelector(".v26Player video");
  assert.ok(video, "player opens under the goal");
  assert.equal(video.getAttribute("src"), `${BASE}/tg/live/20261010/phi-bos/a.mp4`, "light version first");
  assert.equal(video.getAttribute("poster"), `${BASE}/live/20261010/phi-bos/a.jpg`);
  assert.equal(video.__played, true, "playback starts from the tap");
  assert.equal(doc.querySelectorAll(".v26Player").length, 1);
  assert.ok(video.closest('[data-slot="405"]'), "player sits in the row of that goal");
  assert.match(text(doc.querySelector(".v26Q")), /Оригинал · 36 МБ/);
  assert.match(text(doc.querySelector(".v26Q")), /Лёгкая · 11 МБ/);
  assert.equal(doc.querySelector(".v26Q .on").dataset.q, "light");
  // original on request
  doc.querySelector('.v26Q [data-q="orig"]').click();
  assert.equal(doc.querySelector(".v26Player video").getAttribute("src"), `${BASE}/live/20261010/phi-bos/a.mp4`);
  assert.equal(window.localStorage.getItem("hoh-v26-quality"), null, "the choice is not stored for the next visit");
  // another goal: one player at a time; this clip has no light copy
  doc.querySelector('[data-goal="407"] .v26Play').click();
  assert.equal(doc.querySelectorAll(".v26Player").length, 1);
  assert.ok(doc.querySelector('[data-slot="407"] video'));
  assert.equal(doc.querySelector('[data-slot="407"] video').getAttribute("src"), `${BASE}/live/20261010/phi-bos/b.mp4`, "no light copy: original is used");
  assert.ok(!doc.querySelector(".v26Q"), "no quality switch without a light copy");
  // tapping the same button closes it
  doc.querySelector('[data-goal="407"] .v26Play').click();
  assert.ok(!doc.querySelector("video"));
  // compilations follow the choice made on this screen
  doc.querySelector('[data-special="all_goals"]').click();
  assert.equal(doc.querySelector("#v26Special video").getAttribute("src"), `${BASE}/live/20261010/phi-bos/ALL.mp4`, "the original chosen on this screen applies to compilations too");
  doc.querySelector('#v26Special [data-q="light"]').click();
  assert.equal(doc.querySelector("#v26Special video").getAttribute("src"), `${BASE}/tg/live/20261010/phi-bos/ALL.mp4`);
  doc.querySelector('[data-special="all_goals"]').click();
  assert.ok(!doc.querySelector("video"));
  // a fresh visit to a match starts with the light version again
  await H.openGameV26(123, { returnTab: "games" });
  doc.querySelector('[data-goal="405"] .v26Play').click();
  assert.equal(doc.querySelector(".v26Player video").getAttribute("src"), `${BASE}/tg/live/20261010/phi-bos/a.mp4`, "every new visit starts light");
  doc.querySelector('[data-goal="405"] .v26Play').click();

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

  // About tab
  doc.querySelector('[data-v26-tab="about"]').click();
  assert.deepEqual([...doc.querySelectorAll(".v26Odd b")].map(text), ["2.20", "4.20", "2.75"]);
  assert.match(text(doc.querySelector(".v26Odds")), /BOS.*Ничья.*PHI/);
  assert.match(text(doc.querySelector(".v26Info")), /TD Garden/);
  assert.equal(doc.querySelector(".v26Vk").dataset.link, "https://vkvideo.ru/video-1_2");
  doc.querySelector('[data-v26-tab="goals"]').click();
  assert.equal(doc.querySelectorAll(".v26Goal").length, 4);

  // back button honours the caller
  doc.getElementById("v15Back").click();
  assert.equal(calls.back, 1);
  assert.equal(window.HOHV26.state.timer, null, "polling stops when leaving");
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
  assert.equal(window.HOHV26.state.timer, null, "no polling before the game");
  window.close();
}

{
  // clip server down: goals still shown, clear message
  const down = buildGoalsPayload({ gamePk: 123, landing: landing(), index: null, indexOk: false, names: NAMES, now: NOW, clipsBase: BASE });
  const { window, doc, H } = makeScreen({ payload: down });
  await H.openGameV26(123, {});
  assert.equal(doc.querySelectorAll(".v26Goal").length, 3);
  assert.match(text(doc.querySelector(".v26List")), /Видео временно недоступно/);
  assert.ok(!doc.querySelector(".v26Play"));
  window.close();
}

{
  // goals feed down at open time: header + retry; a failing game request throws so the classic page can take over
  const { window, doc, box, H } = makeScreen({ payload: null });
  await H.openGameV26(123, {});
  assert.match(text(doc.querySelector(".v26Note")), /Голы временно недоступны/);
  box.payload = livePayload();
  doc.querySelector("[data-retry]").click();
  await new Promise((r) => setTimeout(r, 20));
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

// ---- 5) goals of one player -------------------------------------------------------------------------------------------------
const goalOf = (eventId, period, remaining, away, home, scorer, scorerId, team, path) => ({ event_id: eventId, period, time_remaining: remaining, away_score: away, home_score: home, scorer, scorer_id: scorerId, team, ...clip(path) });
const PIDX = {
  version: 1,
  games: [
    { game_pk: 2026020044, date: "20261006", kind: "vod", away: "NSH", home: "TOR", goals: [
      goalOf(144, 1, "12:47", 1, 0, "Steven Stamkos", 8474564, "NSH", "vod/20261006/nsh-tor/a.mp4"),
      goalOf(1120, 4, "00:14", 4, 5, "Auston Matthews", 8479318, "TOR", "vod/20261006/nsh-tor/b.mp4"),
    ] },
    { game_pk: 2026020044, date: "20261006", kind: "live", away: "NSH", home: "TOR", goals: [goalOf(144, 1, "12:47", 1, 0, "Steven Stamkos", 8474564, "NSH", "live/20261006/nsh-tor/a.mp4")] },
    { game_pk: 2026020046, date: "20261006", kind: "vod", away: "OTT", home: "DET", goals: [
      goalOf(85, 1, "17:16", 1, 0, "Tim Stützle", null, "OTT", "vod/20261006/ott-det/a.mp4"),
      goalOf(99, 1, "16:44", 1, 1, "Alex DeBrincat", null, "DET", "vod/20261006/ott-det/b.mp4"),
    ] },
    { game_pk: 2026020068, date: "20261009", kind: "live", away: "PIT", home: "CBJ", goals: [
      goalOf(474, 5, "00:00", 2, 3, "Kent Johnson", 8482660, "CBJ", "live/20261009/pit-cbj/a.mp4"),
      goalOf(175, 1, "09:08", 0, 1, "Damon Severson", 8476923, "CBJ", "live/20261009/pit-cbj/b.mp4"),
    ] },
    { game_pk: 2026020070, date: "20261010", kind: "live", away: "AAA", home: "BBB", goals: [goalOf(7, 1, "10:00", 1, 0, "Steven Stamkos", 999, "AAA", "live/20261010/aaa-bbb/a.mp4")] },
    { game_pk: 2026030111, date: "20270420", kind: "live", away: "NSH", home: "VGK", goals: [goalOf(900, 4, "16:00", 2, 3, "Steven Stamkos", 8474564, "NSH", "live/20270420/nsh-vgk/a.mp4")] },
  ],
};
{
  const stamkos = buildPlayerGoalsPayload({ playerId: 8474564, nameEn: "Steven Stamkos", nameRu: "Стивен Стэмкос", index: PIDX, indexOk: true, clipsBase: BASE });
  assert.equal(stamkos.total, 2, "the same goal listed twice is counted once");
  assert.equal(stamkos.games, 2);
  assert.equal(stamkos.since, "2026-10-06", "first day of the video base");
  assert.deepEqual(stamkos.goals.map((g) => g.game_pk), [2026030111, 2026020044], "newest game first");
  const [playoff, regular] = stamkos.goals;
  assert.equal(regular.time, "07:13", "elapsed time, not the time left");
  assert.equal(regular.opponent, "TOR");
  assert.equal(regular.team, "NSH");
  assert.deepEqual(regular.score_after, { away: 1, home: 0 });
  assert.equal(regular.clip.orig_url, `${BASE}/vod/20261006/nsh-tor/a.mp4`);
  assert.equal(regular.clip.state, "ready");
  assert.deepEqual([playoff.period.short_ru, playoff.time], ["ОТ", "04:00"], "a playoff overtime lasts 20 minutes");
  assert.equal(stamkos.player.name_ru, "Стивен Стэмкос");

  const matthews = buildPlayerGoalsPayload({ playerId: 8479318, index: PIDX, indexOk: true, clipsBase: BASE });
  assert.deepEqual([matthews.goals[0].period.short_ru, matthews.goals[0].time], ["ОТ", "04:46"], "regular-season overtime: five minutes");
  const shootout = buildPlayerGoalsPayload({ playerId: 8482660, index: PIDX, indexOk: true, clipsBase: BASE });
  assert.deepEqual([shootout.goals[0].period.short_ru, shootout.goals[0].time], ["Б", null], "shootout: no clock");

  const byName = buildPlayerGoalsPayload({ playerId: 8482116, nameEn: "Tim Stutzle", index: PIDX, indexOk: true, clipsBase: BASE });
  assert.equal(byName.total, 1, "clips without a player id are matched by name, accents ignored");
  assert.equal(byName.goals[0].time, "02:44");
  assert.equal(buildPlayerGoalsPayload({ playerId: 8482116, index: PIDX, indexOk: true, clipsBase: BASE }).total, 0, "no name, no id: nothing is guessed");
  assert.equal(buildPlayerGoalsPayload({ playerId: 1, nameEn: "Nobody Atall", index: PIDX, indexOk: true, clipsBase: BASE }).total, 0);
  const down = buildPlayerGoalsPayload({ playerId: 8474564, nameEn: "Steven Stamkos", index: null, indexOk: false, clipsBase: BASE });
  assert.deepEqual([down.server_ok, down.total, down.since], [false, 0, null]);
}
{
  const db = { prepare: () => ({ bind: (id) => ({ first: async () => (id === 8474564 ? { full_name_en: "Steven Stamkos", full_name_ru: "Стивен Стэмкос" } : null) }) }) };
  const env = { DB: db, HOH_CLIPS_BASE: BASE };
  globalThis.fetch = async (url) => (String(url).endsWith("/index.json") ? new Response(JSON.stringify(PIDX), { status: 200 }) : new Response("no", { status: 500 }));
  const path = "/api/telegram-center-v26/players/8474564/goals";
  const ok = await handleTelegramCenterV26(new Request("https://x.test" + path), env, path);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.equal(body.player.name_ru, "Стивен Стэмкос", "player name comes from the players table");
  assert.equal(body.total, 2);
  assert.equal((await handleTelegramCenterV26(new Request("https://x.test/a", { method: "POST" }), env, path)).status, 405);
  assert.equal((await handleTelegramCenterV26(new Request("https://x.test/a"), env, "/api/telegram-center-v26/players/abc/goals")), null, "only numeric ids are routed");
  globalThis.fetch = async () => new Response("no", { status: 502 });
  const offline = await (await handleTelegramCenterV26(new Request("https://x.test" + path), env, path)).json();
  assert.deepEqual([offline.ok, offline.server_ok, offline.total], [true, false, 0], "clip server down: the page still answers");
  globalThis.fetch = realFetch;
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
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
    current: { p: { player_id: 8474564, full_name_ru: "Стивен Стэмкос" } },
    renderMain: (ctx) => { rendered.push(ctx); doc.getElementById("view").innerHTML = profileHtml; },
  };
  const render = () => { doc.getElementById("view").innerHTML = profileHtml; };
  return { ...made, seen, rendered, render };
}
{
  const payload = buildPlayerGoalsPayload({ playerId: 8474564, nameEn: "Steven Stamkos", nameRu: "Стивен Стэмкос", index: PIDX, indexOk: true, clipsBase: BASE });
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

  doc.querySelector(".v26PgBtn").click();
  await settle();
  assert.deepEqual(seen, ["/api/telegram-center-v26/players/8474564/goals"]);
  assert.match(text(doc.querySelector("#v26PgHero")), /Стивен Стэмкос/);
  assert.match(text(doc.querySelector("#v26PgHero")), /Голов с видео: 2 · матчей: 2 · видео в базе с 6 октября/);
  assert.deepEqual([...doc.querySelectorAll(".v26GameHead span")].map(text), ["20 апреля", "6 октября"]);
  assert.deepEqual([...doc.querySelectorAll(".v26GameHead b")].map(text), ["NSH — VGK", "NSH — TOR"]);
  const rows = [...doc.querySelectorAll("[data-pg-goal]")];
  assert.equal(rows.length, 2);
  assert.match(text(rows[1]), /1-й\s*07:13/);
  assert.match(text(rows[1]), /NSH.*в гостях.*Счёт после гола 1:0/);
  assert.match(text(rows[0]), /ОТ\s*04:00/);
  assert.ok(!/\sdata-(player|team|tab)=/.test(doc.getElementById("v26PgRoot").innerHTML), "no attributes that the global handlers swallow");

  // the same inline player as in the match: light version first, original on request
  rows[1].querySelector(".v26Play").click();
  const video = doc.querySelector(".v26Player video");
  assert.equal(video.getAttribute("src"), `${BASE}/tg/vod/20261006/nsh-tor/a.mp4`);
  assert.equal(video.__played, true);
  assert.ok(video.closest('[data-pg-slot="2026020044:144"]'));
  doc.querySelector('.v26Q [data-pg-q="orig"]').click();
  assert.equal(doc.querySelector(".v26Player video").getAttribute("src"), `${BASE}/vod/20261006/nsh-tor/a.mp4`);
  doc.querySelector('[data-pg-goal="2026030111:900"] .v26Play').click();
  assert.equal(doc.querySelectorAll(".v26Player").length, 1, "one player at a time");
  assert.equal(doc.querySelector(".v26Player video").getAttribute("src"), `${BASE}/live/20270420/nsh-vgk/a.mp4`, "the original chosen on this page stays");
  doc.querySelector('[data-pg-goal="2026030111:900"] .v26Play').click();
  assert.ok(!doc.querySelector("video"), "tapping again closes it");

  // a game header opens the match, and the match's back button returns to this list
  doc.querySelector('[data-pg-game="2026020044"]').click();
  await settle();
  assert.ok(doc.getElementById("v26Root") && !doc.getElementById("v26PgRoot"), "the match screen is open");
  doc.getElementById("v15Back").click();
  await settle();
  assert.ok(doc.getElementById("v26PgRoot"), "back from the match returns to the player's goals");
  assert.equal(doc.querySelectorAll("[data-pg-goal]").length, 2);

  // back from the list returns to the profile without reloading it
  doc.getElementById("v15Back").click();
  assert.equal(rendered.length, 1, "the profile layer redraws the profile it already holds");
  assert.equal(rendered[0], window.HOHV23.current);
  await settle();
  assert.equal(doc.querySelectorAll(".v26PgBtn").length, 1, "and the goals button comes back with it");
  window.close();
}
{
  // no video yet, spoilers hidden, failures: every state says something understandable
  const empty = buildPlayerGoalsPayload({ playerId: 5, nameEn: "Nobody Atall", index: PIDX, indexOk: true, clipsBase: BASE });
  const a = makeProfile({ payload: empty });
  a.render(); await settle();
  a.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.match(text(a.doc.querySelector("#v26PgBody")), /Роликов с голами этого игрока пока нет\. Видео в базе с 6 октября\./);
  a.window.close();

  const payload = buildPlayerGoalsPayload({ playerId: 8474564, nameEn: "Steven Stamkos", index: PIDX, indexOk: true, clipsBase: BASE });
  const b = makeProfile({ payload });
  b.window.HOHNoSpoilers = () => true;
  b.render(); await settle();
  b.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.ok(!b.doc.querySelector("[data-pg-goal]"), "goals are hidden in no-spoilers mode");
  assert.ok(!/Голов с видео/.test(text(b.doc.querySelector("#v26PgHero"))), "and so is the count");
  b.doc.querySelector("[data-pg-reveal]").click();
  assert.equal(b.doc.querySelectorAll("[data-pg-goal]").length, 2);
  b.window.close();

  const c = makeProfile({ payload: null, fail: true });
  c.render(); await settle();
  c.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.match(text(c.doc.querySelector("#v26PgBody")), /Голы игрока временно недоступны/);
  assert.ok(c.doc.querySelector("[data-pg-retry]"));
  c.window.close();

  const d = makeProfile({ payload: buildPlayerGoalsPayload({ playerId: 8474564, index: null, indexOk: false, clipsBase: BASE }) });
  d.render(); await settle();
  d.doc.querySelector(".v26PgBtn").click(); await settle();
  assert.match(text(d.doc.querySelector("#v26PgBody")), /Видео временно недоступно/);
  d.window.close();
}

console.log("GOALS_SCREEN_OK");
process.exit(0);
