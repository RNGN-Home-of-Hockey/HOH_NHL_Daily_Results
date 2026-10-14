// v31: the portrait of a player — the hexagon on his page (the share of the players of his position he is better than, axis by
// axis), his strengths and weaker sides in plain words; plus the bright tendencies, the short Winline card and the season stats
// by category with the strongest numbers first. The NHL stats API is faked, D1 runs on SQLite with the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import {
  SCRIPT_PATH, SKATER_AXES, GOALIE_AXES, MIN_GAMES, percentile, groupOf, currentSeason, computeProfiles, describe,
  runPlayerProfileMaintenance, handleTelegramCenterV31,
} from "../cloudflare-worker/src/telegram-center-v31-player-profile.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";
import { handleTelegramCenterV23PlayerUi } from "../cloudflare-worker/src/telegram-center-v23-player-ui.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const lineOf = (source, start) => {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  return source.slice(i, source.indexOf("\n", i));
};

// ---- 1) the numbers: percentiles, positions, the season ---------------------------------------------------------------------------------------
assert.equal(percentile(5, []), null, "nobody to compare with");
assert.equal(percentile(10, [1, 2, 3, 10]), 88, "better than 3, equal to himself (a tie counts half)");
assert.equal(percentile(0, [0, 0, 0, 0]), 50, "all equal: the middle, not the bottom");
assert.equal(percentile(1, [2, 3]), 0);
assert.equal(percentile(9, [2, 3]), 100);
assert.deepEqual(["C", "L", "R", "D", "G", "", null].map(groupOf), ["F", "F", "F", "D", "G", "F", "F"]);
assert.equal(currentSeason(Date.parse("2026-10-14T12:00:00Z")), "20262027");
assert.equal(currentSeason(Date.parse("2027-03-01T12:00:00Z")), "20262027");
assert.equal(currentSeason(Date.parse("2026-09-01T00:00:00Z")), "20262027", "the season starts with the camps");
assert.equal(currentSeason(Date.parse("2026-08-31T23:00:00Z")), "20252026");
assert.deepEqual(SKATER_AXES.map((a) => a.label), ["Атака", "Пас", "Большинство", "Лидерство", "Меньшинство", "Сила"], "the six axes of the hexagon");
assert.deepEqual(GOALIE_AXES.map((a) => a.label), ["Отражения", "Надёжность", "Победы", "Нагрузка", "Сухие"]);

// the league in miniature: 4 forwards, 3 defencemen, 3 goalies
const sk = (playerId, positionCode, gamesPlayed, goals, assists, ppPoints, timeOnIcePerGame) => ({ playerId, positionCode, gamesPlayed, goals, assists, ppPoints, timeOnIcePerGame });
const SUMMARY = [
  sk(1, "L", 7, 8, 3, 3, 1266), // the star (Kaprizov-like)
  sk(2, "C", 7, 2, 6, 1, 1100),
  sk(3, "R", 7, 0, 1, 0, 700),
  sk(4, "C", 2, 1, 0, 0, 900), // two games only: shown, but not a yardstick for the others
  sk(5, "D", 7, 1, 5, 2, 1500),
  sk(6, "D", 7, 0, 1, 0, 1200),
  sk(7, "D", 7, 0, 0, 0, 1000),
];
const REALTIME = [{ playerId: 1, hits: 3, blockedShots: 2 }, { playerId: 2, hits: 10, blockedShots: 4 }, { playerId: 3, hits: 20, blockedShots: 5 }, { playerId: 5, hits: 6, blockedShots: 15 }, { playerId: 6, hits: 14, blockedShots: 9 }];
const TOI = [{ playerId: 1, shTimeOnIcePerGame: 2 }, { playerId: 2, shTimeOnIcePerGame: 95 }, { playerId: 3, shTimeOnIcePerGame: 120 }, { playerId: 5, shTimeOnIcePerGame: 140 }];
const GOALIES = [
  { playerId: 31, gamesPlayed: 5, gamesStarted: 5, wins: 3, shutouts: 1, savePct: 0.912, goalsAgainstAverage: 2.46 },
  { playerId: 32, gamesPlayed: 4, gamesStarted: 4, wins: 1, shutouts: 0, savePct: 0.889, goalsAgainstAverage: 3.4 },
  { playerId: 33, gamesPlayed: 3, gamesStarted: 2, wins: 2, shutouts: 0, savePct: 0.925, goalsAgainstAverage: 2.1 },
  { playerId: 34, gamesPlayed: 0, gamesStarted: 0, wins: 0, shutouts: 0, savePct: 0, goalsAgainstAverage: 0 }, // has not played: no portrait
];
const profiles = computeProfiles({ summary: SUMMARY, realtime: REALTIME, toi: TOI, goalies: GOALIES });
const P = (id) => profiles.find((p) => p.player_id === id);
assert.deepEqual(profiles.map((p) => p.player_id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 31, 32, 33], "everybody who played, nobody else");
assert.deepEqual([P(1).pos_group, P(5).pos_group, P(31).pos_group], ["F", "D", "G"]);
assert.equal(P(1).peers, 3, "forwards are compared with the forwards of 3+ games");
assert.equal(P(5).peers, 3, "defencemen with defencemen");
assert.equal(P(31).peers, 3);
assert.equal(P(4).peers, 3, "the forward of two games is measured against the others");
assert.equal(P(1).axes.attack, 83, "the best scorer: better than both others, equal to himself");
assert.equal(P(3).axes.attack, 17);
assert.equal(P(1).axes.physical, 17, "the star does not hit");
assert.equal(P(3).axes.physical, 83);
assert.equal(P(1).axes.pk, 17, "and does not kill penalties");
assert.equal(P(5).axes.passing, 83, "the defenceman is not compared with the forwards");
assert.equal(P(1).values.attack, 1.143, "the numbers behind the axes, per game");
assert.equal(P(1).values.toi, 1266);
assert.equal(P(6).values.pk, 0, "nobody in the time-on-ice report: zero, not a crash");
assert.equal(P(33).axes.save, 83, "the best save percentage");
assert.equal(P(33).axes.gaa, 83, "fewer goals against is better");
assert.equal(P(32).axes.gaa, 17);
assert.equal(P(31).axes.load, 83, "the most starts");
{
  const few = computeProfiles({ summary: SUMMARY, realtime: REALTIME, toi: TOI, goalies: GOALIES }, { minGames: 8 });
  assert.equal(few.find((p) => p.player_id === 1).axes.attack, null, "nobody with enough games: no percentile, not a fake one");
}

// ---- 2) the plain words ------------------------------------------------------------------------------------------------------------------
{
  const d = describe(P(1));
  assert.deepEqual(d.axes.map((a) => [a.label, a.pct]), [["Атака", 83], ["Пас", 50], ["Большинство", 83], ["Лидерство", 83], ["Меньшинство", 17], ["Сила", 17]]);
  assert.deepEqual(d.strengths.map((x) => x.label), ["Атака", "Большинство", "Лидерство"], "the three best, the best first");
  assert.deepEqual(d.weaker.map((x) => x.label).sort(), ["Меньшинство", "Сила"], "the two weakest");
  assert.ok(d.weaker[0].pct <= d.weaker[1].pct, "the weakest first");
  const weak = Object.fromEntries(d.weaker.map((x) => [x.key, x.text]));
  assert.equal(d.strengths[0].text, "1,14 гола за матч");
  assert.equal(d.strengths[0].note, "лучше 83% нападающих");
  assert.equal(d.strengths[1].text, "0,43 очка в большинстве за матч");
  assert.equal(d.strengths[2].text, "21:06 на льду за матч");
  assert.equal(weak.pk, "почти не играет в меньшинстве", "2 seconds a game is not «0:02 в меньшинстве»");
  assert.equal(weak.physical, "0,7 хита и блока за матч");
  assert.equal(d.peers_word, "нападающих");
  assert.ok(!d.strengths.some((x) => d.weaker.includes(x)));
}
{
  const d = describe(P(5));
  assert.equal(d.peers_word, "защитников");
  assert.ok(d.strengths.every((x) => x.pct >= 60) && d.weaker.every((x) => x.pct < 40), "the middle (40..59) is neither");
  const mid = describe({ pos_group: "F", games: 7, axes: { attack: 59, passing: 61, pp: 40, toi: 39, pk: 10, physical: 25 }, values: { attack: 0.3, passing: 0.5, pp: 0.1, toi: 900, pk: 30, physical: 1.2 }, raw: {} });
  assert.deepEqual(mid.strengths.map((x) => x.key), ["passing"], "strong from 60 up: 59 is not a strength");
  assert.deepEqual(mid.weaker.map((x) => x.key), ["pk", "physical"], "weaker below 40, the two lowest, the lowest first (40 is not weak, 39 is not among the two lowest)");
  const g = describe(P(31));
  assert.equal(g.peers_word, "вратарей");
  assert.equal(g.axes.length, 5, "a pentagon for a goalie");
  const by = Object.fromEntries([...g.strengths, ...g.weaker].map((x) => [x.key, x.text]));
  assert.equal(by.load, "5 стартов");
  const all = Object.fromEntries(GOALIE_AXES.map((a) => [a.key, a.text(P(31).values[a.key], { ...P(31).raw, gp: P(31).games })]));
  assert.deepEqual(all, { save: "91,2% отражённых бросков", gaa: "пропускает 2,46 гола за матч", wins: "3 победы в 5 матчах", load: "5 стартов", shutouts: "1 сухой матч" });
}
// the word after a number: a fraction takes «гола», a whole number its own form
{
  const [attack, , pp, , pk, physical] = SKATER_AXES;
  assert.deepEqual([1, 2, 5, 0, 0.5, 1.14, 21].map((v) => attack.text(v)), ["1 гол за матч", "2 гола за матч", "5 голов за матч", "0 голов за матч", "0,5 гола за матч", "1,14 гола за матч", "21 гол за матч"]);
  assert.deepEqual([0, 1, 0.43, 2].map((v) => pp.text(v)), ["пока без очков в большинстве", "1 очко в большинстве за матч", "0,43 очка в большинстве за матч", "2 очка в большинстве за матч"]);
  assert.deepEqual([4, 95, 120].map((v) => pk.text(v)), ["почти не играет в меньшинстве", "1:35 в меньшинстве за матч", "2:00 в меньшинстве за матч"]);
  assert.deepEqual([10, 1, 2.04, 0.7].map((v) => physical.text(v)), ["10 хитов и блоков за матч", "1 хит или блок за матч", "2 хита и блока за матч", "0,7 хита и блока за матч"]);
  assert.equal(GOALIE_AXES[1].text(-1), "пропускает 1 гол за матч");
  assert.equal(GOALIE_AXES[2].text(0, { wins: 1, gp: 1 }), "1 победа в 1 матче");
  assert.equal(GOALIE_AXES[4].text(0, { shutouts: 5 }), "5 сухих матчей");
}

// ---- 3) the maintenance: the league every 6 hours, a pause when the NHL stats are down ------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const createOf = (file, table) => fs.readFileSync(new URL(file, MIG), "utf8").match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(createOf("0051_player_season_profiles.sql", "player_season_profiles"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const db = { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } };
const env = { DB: db };

// a whole league: 150 skaters, 20 goalies, plus the miniature above
const LEAGUE = {
  summary: [...SUMMARY, ...Array.from({ length: 150 }, (_, i) => sk(100 + i, i % 3 ? "C" : "D", 6, i % 5, i % 7, i % 3, 900 + i * 3))],
  realtime: [...REALTIME, ...Array.from({ length: 150 }, (_, i) => ({ playerId: 100 + i, hits: i % 11, blockedShots: i % 6 }))],
  timeonice: [...TOI, ...Array.from({ length: 150 }, (_, i) => ({ playerId: 100 + i, shTimeOnIcePerGame: (i * 13) % 150 }))],
  goalies: [...GOALIES, ...Array.from({ length: 20 }, (_, i) => ({ playerId: 500 + i, gamesPlayed: 4, gamesStarted: 4, wins: i % 4, shutouts: i % 2, savePct: 0.88 + i / 1000, goalsAgainstAverage: 2 + i / 10 }))],
};
const nhl = { down: false, asked: [], skaters: null };
const fetcher = async (url, init) => {
  nhl.asked.push(url);
  assert.equal(init.headers.Accept, "application/json");
  if (nhl.down) throw new Error("timeout");
  const u = new URL(url);
  assert.equal(u.searchParams.get("limit"), "-1", "the whole league in one page");
  assert.equal(u.searchParams.get("cayenneExp"), "seasonId=20262027 and gameTypeId=2", "the regular season of now");
  const report = u.pathname.replace("/stats/rest/en/", "");
  const data = { "skater/summary": nhl.skaters || LEAGUE.summary, "skater/realtime": LEAGUE.realtime, "skater/timeonice": LEAGUE.timeonice, "goalie/summary": LEAGUE.goalies }[report];
  assert.ok(data, `unexpected report ${report}`);
  return new Response(JSON.stringify({ data }), { status: 200 });
};
const NOW = Date.parse("2026-10-14T20:00:00Z");
const rows = () => raw.prepare("SELECT COUNT(*) AS n FROM player_season_profiles").get().n;
const setMetaTime = (key, at) => raw.prepare("UPDATE data_core_meta SET updated_at=? WHERE meta_key=?").run(at, key);
{
  assert.deepEqual(await runPlayerProfileMaintenance({}), { ok: false, error: "missing_d1_binding" });
  const r1 = await runPlayerProfileMaintenance(env, { now: NOW, fetcher });
  assert.deepEqual(r1, { ok: true, season: "20262027", players: 180 }, "157 skaters and 23 goalies who played");
  assert.equal(rows(), 180);
  assert.equal(nhl.asked.length, 4, "four reports: the scoring, the hits and blocks, the time on ice, the goalies");
  const row = raw.prepare("SELECT * FROM player_season_profiles WHERE season_id='20262027' AND player_id=1").get();
  assert.equal(row.pos_group, "F");
  assert.equal(row.games, 7);
  assert.ok(row.peers > 100, "compared with the whole league");
  const axes = JSON.parse(row.axes_json);
  assert.deepEqual(Object.keys(axes), ["attack", "passing", "pp", "toi", "pk", "physical"]);
  assert.ok(axes.attack > 95, "8 goals in 7 games: the top of the league");
  assert.equal(JSON.parse(row.values_json).raw.goals, 8, "the raw numbers are kept for the words of the goalie axes");

  nhl.asked.length = 0;
  setMetaTime("player_profiles_v31", "2026-10-14 19:00:00");
  assert.deepEqual(await runPlayerProfileMaintenance(env, { now: NOW, fetcher }), { ok: true, skipped: true, reason: "fresh" });
  assert.equal(nhl.asked.length, 0, "fresh for 6 hours: the NHL is not asked every 5 minutes");

  setMetaTime("player_profiles_v31", "2026-10-14 13:30:00"); // the last good run 6.5 hours ago
  raw.prepare("UPDATE data_core_meta SET meta_value=? WHERE meta_key='player_profiles_v31_try'").run(String(NOW - 6.5 * 3600 * 1000));
  nhl.down = true;
  await assert.rejects(runPlayerProfileMaintenance(env, { now: NOW, fetcher }), /timeout/, "an honest failure for the log of the cron");
  assert.equal(rows(), 180, "the portraits of before stay");
  nhl.asked.length = 0;
  assert.deepEqual(await runPlayerProfileMaintenance(env, { now: NOW + 5 * 60 * 1000, fetcher }), { ok: true, skipped: true, reason: "retry_later" });
  assert.equal(nhl.asked.length, 0, "the NHL down: the next try in half an hour, not in 5 minutes");
  nhl.down = false;
  const r2 = await runPlayerProfileMaintenance(env, { now: NOW + 31 * 60 * 1000, fetcher });
  assert.equal(r2.ok, true);
  assert.equal(r2.players, 180);

  nhl.skaters = SUMMARY;
  const r3 = await runPlayerProfileMaintenance(env, { now: NOW + 40 * 60 * 1000, fetcher, force: true });
  assert.deepEqual(r3, { ok: false, error: "nhl_stats_incomplete", skaters: 7 }, "a cut report does not rewrite the league with 7 players");
  nhl.skaters = null;
  assert.equal(JSON.parse(raw.prepare("SELECT axes_json FROM player_season_profiles WHERE player_id=1").get().axes_json).attack, axes.attack);
}

// ---- 4) the API and the script ------------------------------------------------------------------------------------------------------------
{
  const get = (path, method = "GET") => handleTelegramCenterV31(new Request(`https://x.test${path}`, { method }), env, new URL(`https://x.test${path}`).pathname);
  assert.equal(await get("/api/other"), null);
  assert.equal(await get("/api/telegram-center-v31/players/abc/profile"), null, "only numeric ids");
  assert.equal((await get("/api/telegram-center-v31/players/1/profile", "POST")).status, 405);
  assert.equal((await handleTelegramCenterV31(new Request("https://x.test/api/telegram-center-v31/players/1/profile"), {}, "/api/telegram-center-v31/players/1/profile")).status, 503);
  const res = await get("/api/telegram-center-v31/players/1/profile?season=20262027");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Cache-Control"), /max-age=300/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.profile.pos_group, "F");
  assert.equal(body.profile.peers_word, "нападающих");
  assert.equal(body.profile.axes.length, 6);
  assert.equal(body.profile.low_sample, false);
  assert.ok(body.profile.strengths.length >= 1 && body.profile.strengths[0].label === "Атака");
  assert.ok(!("raw" in body.profile) && !("values" in body.profile), "only what the page shows");
  const goalie = await (await get("/api/telegram-center-v31/players/31/profile?season=20262027")).json();
  assert.equal(goalie.profile.axes.length, 5);
  assert.ok([...goalie.profile.strengths, ...goalie.profile.weaker].every((x) => !/undefined|NaN/.test(x.text)), "the goalie words have their numbers");
  const small = await (await get("/api/telegram-center-v31/players/4/profile?season=20262027")).json();
  assert.equal(small.profile.low_sample, true, `fewer than ${MIN_GAMES} games: the page says the portrait is early`);
  const none = await (await get("/api/telegram-center-v31/players/8400001/profile?season=20262027")).json();
  assert.deepEqual(none, { ok: true, season: "20262027", player_id: 8400001, profile: null });
  const old = await (await get("/api/telegram-center-v31/players/1/profile?season=20212022")).json();
  assert.equal(old.profile, null, "another season: nothing invented");
  const bad = await (await get("/api/telegram-center-v31/players/1/profile?season=1;DROP")).json();
  assert.equal(bad.season, currentSeason(), "a bad season falls back to the current one");
  raw.prepare("UPDATE player_season_profiles SET axes_json='{' WHERE player_id=2").run();
  assert.equal((await get("/api/telegram-center-v31/players/2/profile?season=20262027")).status, 500);

  const script = await (await get(SCRIPT_PATH)).text();
  assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
  assert.equal((await get(SCRIPT_PATH, "POST")).status, 405);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v31-player.js?build=31.0"), "the script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v31-player.js") > shell.indexOf("/telegram-app/v30-nav.js"), "after the navigation layer");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).status, 200, "reachable through the main router");
  const entry = fs.readFileSync(new URL("../cloudflare-worker/src/worker-entry.js", import.meta.url), "utf8");
  assert.match(entry, /try \{\s*await runPlayerProfileMaintenance\(env\);\s*\} catch \(error\) \{/, "the cron runs it, a failure does not stop the rest");
  assert.ok(entry.indexOf("runPlayerProfileMaintenance(env)") > entry.indexOf("runFanPredictionDigest(env)"), "after the points of the fans: a slow NHL stats site does not delay them");

  // ---- 5) the card on the player page
  const html = `<!doctype html><html class="v15Light"><head></head><body><main id="view"><div class="v23PlayerProfile"><div class="v23Head">Кирилл Капризов</div><div id="v23Season">Статистика сезона</div><div class="v23Rest"></div></div></main></body></html>`;
  const dom = new JSDOM(html, { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  window.HOHV15 = { api: async (url) => { calls.push(url); const u = new URL(url, "https://x.test"); const r = await handleTelegramCenterV31(new Request(u), env, u.pathname); return r.json(); } };
  window.HOHV23 = { current: { p: { player_id: 1 }, pack: { season: "20262027" } } };
  window.eval(script);
  await tick(150);
  let card = doc.querySelector("[data-v31-portrait]");
  assert.ok(card, "the portrait is on the page");
  assert.equal(card.previousElementSibling.id, "v23Season", "right after the season numbers");
  assert.deepEqual(calls, ["/api/telegram-center-v31/players/1/profile?season=20262027"]);
  const svg = card.querySelector("svg.v31Radar");
  assert.equal(svg.getAttribute("viewBox"), "-40 0 400 280", "room on the sides: «Большинство» and «Меньшинство» are not cut on a phone");
  assert.equal(svg.querySelectorAll("polygon.ring").length, 4);
  assert.equal(svg.querySelector("polygon.area").getAttribute("points").split(" ").length, 6, "a hexagon");
  assert.deepEqual([...svg.querySelectorAll("text.lab")].map((t) => t.textContent), ["Атака", "Пас", "Большинство", "Лидерство", "Меньшинство", "Сила"]);
  assert.match(svg.getAttribute("aria-label"), /^Портрет игрока: Атака \d+, Пас \d+/);
  assert.match(card.textContent, /Сильные стороны/);
  assert.equal(card.querySelector(".v31Side:not(.weak) .v31Item b").textContent, "Атака", "the best first");
  assert.match(card.querySelector(".v31Side:not(.weak) .v31Item span:last-child").textContent, /гола за матч · лучше \d+% нападающих/);
  assert.equal(card.querySelector(".v31PHead small").textContent, "лучше скольких нападающих, %");
  assert.ok(doc.getElementById("v31css").textContent.includes(".v31Trend{"), "the bright tendencies are styled by this layer");

  // the same player: nothing redrawn, nothing asked again
  window.HOHV31.update();
  assert.equal(doc.querySelector("[data-v31-portrait]"), card);
  assert.equal(calls.length, 1);

  // another player: the card follows
  window.HOHV23.current = { p: { player_id: 31 }, pack: { season: "20262027" } };
  doc.querySelector(".v23Rest").append(doc.createElement("i"));
  await tick(200);
  card = doc.querySelector("[data-v31-portrait]");
  assert.equal(doc.querySelectorAll("[data-v31-portrait]").length, 1, "one card, not two");
  assert.equal(card.dataset.key, "31:20262027");
  assert.equal(card.querySelector("polygon.area").getAttribute("points").split(" ").length, 5, "a pentagon for a goalie");
  assert.equal(card.querySelector(".v31PHead small").textContent, "лучше скольких вратарей, %");

  // a player without a portrait: no empty card
  window.HOHV23.current = { p: { player_id: 8400001 }, pack: { season: "20262027" } };
  doc.querySelector(".v23Rest").append(doc.createElement("i"));
  await tick(200);
  assert.equal(doc.querySelectorAll("[data-v31-portrait]").length, 0, "the card of the previous player is gone");
  window.HOHV23.current = { p: { player_id: 4 }, pack: { season: "20262027" } };
  doc.querySelector(".v23Rest").append(doc.createElement("i"));
  await tick(200);
  assert.match(doc.querySelector("[data-v31-portrait]").textContent, /Пока мало матчей/);

  // the full statistics page is not the profile: no portrait there
  doc.querySelector(".v23PlayerProfile").classList.add("v23StatsPage");
  doc.querySelector("[data-v31-portrait]").remove();
  window.HOHV31.update();
  await tick(60);
  assert.equal(doc.querySelectorAll("[data-v31-portrait]").length, 0);
  window.close();

  // the labels are escaped
  const d2 = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  d2.window.HOHV15 = { api: async () => ({}) };
  d2.window.eval(script);
  assert.ok(!d2.window.HOHV31.radarSvg([{ label: "<b>x</b>", pct: 50 }, { label: "a", pct: null }, { label: "b", pct: 0 }]).includes("<b>x</b>"));
  assert.match(d2.window.HOHV31.radarSvg([{ label: "a", pct: null }, { label: "b", pct: 0 }, { label: "c", pct: 100 }]), />—<\/text>/, "an axis without data shows a dash");
  d2.window.close();
}

// ---- 6) the player page: bright tendencies, the short Winline card, the stats by category ---------------------------------------------------
{
  const v23 = await (await handleTelegramCenterV23PlayerUi(new Request("https://x.test/telegram-app/v23-player.js"), "/telegram-app/v23-player.js")).text();
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(`function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function cleanMarketLabel(v){return String(v).replace(/^Матч\\s*·\\s*/i,'').trim()}
function recommendationFact(){return 'запасной текст'}
${lineOf(v23, "function word(n,one,few,many)")}
${lineOf(v23, "function trendParts(x)")}
${lineOf(v23, "function recFirstCap(v)")}
${lineOf(v23, "function winlineRecommendation(ctx)")}
window.trendParts=trendParts;window.winlineRecommendation=winlineRecommendation;`);
  const w = dom.window;
  assert.deepEqual({ ...w.trendParts({ text: "7 матчей подряд: сыграл минимум 15 минут" }) }, { num: "7", unit: "матчей подряд", text: "сыграл минимум 15 минут" }, "the big number apart from the words");
  assert.deepEqual({ ...w.trendParts({ text: "4 матча подряд: набрал минимум 1 очко" }) }, { num: "4", unit: "матча подряд", text: "набрал минимум 1 очко" });
  assert.deepEqual({ ...w.trendParts({ text: "1 матч подряд: забил" }) }, { num: "1", unit: "матч подряд", text: "забил" });
  assert.deepEqual({ ...w.trendParts({ text: "4 из 5: нанёс минимум 2 броска" }) }, { num: "4 из 5", unit: "последних матчей", text: "нанёс минимум 2 броска" });
  assert.deepEqual({ ...w.trendParts({ text: "Лучший бомбардир команды" }) }, { num: "", unit: "", text: "Лучший бомбардир команды" }, "a text of another shape stays whole");
  assert.match(v23, /function trendBlock\(ctx\)\{[^\n]*class="v23Trend v31Trend"[^\n]*class="v31TNum"><b>'\+esc\(q\.num\)/, "the tendency card shows the number big");
  assert.match(v23, /out\.push\(x\);if\(out\.length>=3\)break\}return out\}/, "up to three tendencies");

  const rec = (market, evidence = {}, home = "MIN") => ({ recommendation: { recommendation: { game: { game_pk: 2026020101, home_tri: home }, market, evidence } } });
  const card = w.winlineRecommendation(rec({ live: true, odds: 1.67, label: "Матч · ПОБЕДА Миннесота", market_id: "m1" }, { hits: 8, decisions: 10, split: "current_venue", team: "MIN" }));
  const box = new JSDOM(`<div>${card}</div>`).window.document;
  assert.equal(box.querySelector(".v31RecText b").textContent, "Победа Миннесота", "what to bet, without «Матч ·» and without shouting");
  assert.equal(box.querySelector(".v31RecText span").textContent, "Проходило в 8 из 10 последних матчей дома", "one fact, once");
  assert.equal(box.querySelector(".v31RecOdds b").textContent, "1.67");
  assert.equal(box.querySelector(".v31Rec").dataset.v23RecGame, "2026020101", "the tap still opens Winline");
  assert.equal(box.querySelector(".v31Rec").textContent.match(/8 из 10/g).length, 1, "nothing repeated");
  const away = w.winlineRecommendation(rec({ live: true, odds: 2.1, label: "Тотал больше 5.5" }, { hits: 6, decisions: 9, split: "current_venue", team: "DAL" }));
  assert.match(away, /Проходило в 6 из 9 последних матчей в гостях/);
  const h2h = w.winlineRecommendation(rec({ live: true, odds: 2.1, label: "Тотал больше 5.5" }, { hits: 3, decisions: 4, split: "h2h" }));
  assert.match(h2h, /Проходило в 3 из 4 последних матчей в очных встречах/);
  assert.match(w.winlineRecommendation(rec({ live: true, odds: 1.9, label: "Х" }, {})), /запасной текст/, "no numbers: the old fact");
  assert.equal(w.winlineRecommendation(rec({ live: false, odds: 1.9, label: "Х" }, {})), "", "a closed market is not offered");
  assert.equal(w.winlineRecommendation(rec({ live: true, odds: 1, label: "Х" }, {})), "");
  assert.equal(w.winlineRecommendation({}), "");
  dom.window.close();

  const groups = lineOf(v23, "function groups(ctx)");
  assert.ok(!/Все показатели|withAll/.test(v23), "no «Все показатели» chessboard");
  assert.match(groups, /strength=x=>Number\(progress\(ctx\.pack,x\[1\],st\[x\[1\]\]\)\)\|\|0/);
  assert.match(groups, /\.sort\(\(a,b\)=>strength\(b\)-strength\(a\)\)/, "inside a category the strongest numbers first");
  assert.equal((groups.match(/return gs\b/g) || []).length, 2, "the goalie and the skater categories, nothing added");
}

console.log("player profile v31 validation passed");
