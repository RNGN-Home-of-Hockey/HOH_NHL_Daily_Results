// Follow-ups of the editor: the standings highlight only the teams that are in the playoff zone right now, the team page shows a
// win/loss mark and home/away in every match row, and the players tab opens by points with the numbers in the row.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { handleTelegramCenterV7 } from "../cloudflare-worker/src/telegram-center-v7.js";
import { handleTelegramCenterV8Ui } from "../cloudflare-worker/src/telegram-center-v8-ui.js";
import { handleTelegramCenterV15TeamUi } from "../cloudflare-worker/src/telegram-center-v15-team-ui.js";

const script = async (handler, path) => (await handler(new Request(`https://x.test${path}`), path)).text();
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const lineOf = (source, start) => {
  const line = source.split("\n").find((l) => l.startsWith(start));
  assert.ok(line, `line starting with ${start} exists`);
  return line;
};

// ---- 1) standings: only the eight teams of the playoff zone are marked --------------------------------------------------------
{
  const realFetch = globalThis.fetch;
  const emptyEnv = { DB: { prepare: () => ({ all: async () => ({ results: [] }) }) } };
  globalThis.fetch = async () => new Response(JSON.stringify({ standings: [] }), { status: 200 });
  const season = (await (await handleTelegramCenterV7(new Request("https://x.test/api/telegram-center-v7/standings"), emptyEnv, "/api/telegram-center-v7/standings")).json()).season;
  // the Atlantic division of the East: three leaders and the first wild card are in; places 3 and 4 of the wild card race are out
  const atlantic = [["OTT", 1, 0, 2], ["TBL", 2, 0, 3], ["BOS", 3, 0, 4], ["TOR", 4, 1, 5], ["BUF", 5, 3, 9], ["FLA", 6, 4, 10], ["MTL", 7, 5, 11], ["DET", 8, 9, 15]];
  const row = ([tri, seq, wc, conf], i) => ({ seasonId: season, teamAbbrev: { default: tri }, gamesPlayed: 6, points: 10 - i, wins: 4, losses: 2, otLosses: 0, divisionSequence: seq, conferenceSequence: conf, wildcardSequence: wc, clinchIndicator: "" });
  globalThis.fetch = async () => new Response(JSON.stringify({ standings: atlantic.map(row) }), { status: 200 });
  const env = { DB: { prepare: () => ({ all: async () => ({ results: atlantic.map(([t]) => ({ tri_code: t, name_en: t, name_ru: t, logo_url: null })) }) }) } };
  const body = await (await handleTelegramCenterV7(new Request("https://x.test/api/telegram-center-v7/standings"), env, "/api/telegram-center-v7/standings")).json();
  const rows = body.conferences[0].divisions[0].rows.filter((r) => r.gp > 0);
  assert.deepEqual(rows.map((r) => r.tri), ["OTT", "TBL", "BOS", "TOR", "BUF", "FLA", "MTL", "DET"]);
  assert.deepEqual(rows.map((r) => r.playoff_status), ["playoff", "playoff", "playoff", "playoff", null, null, null, null], "four teams of this division are in (three leaders and the wild card), nobody is marked as 'in the race'");
  assert.ok(rows.every((r) => r.playoff_status !== "race"));
  globalThis.fetch = realFetch;

  const v8 = await script(handleTelegramCenterV8Ui, "/telegram-app");
  assert.ok(!/гонка за wild card/.test(v8), "no 'wild card race' in the legend");
  assert.ok(!/standingMark">WC</.test(v8), "no WC mark in the rows");
  assert.match(v8, /<span class=\\?"po\\?"><i><\/i>в зоне плей-офф<\/span>/, "the legend keeps the playoff zone");
  assert.match(v8, /<span class="standingMark">ПО<\/span>/, "and the mark of a team in the zone");
}

// ---- 2) team page: win / loss / overtime loss and home / away in every row ----------------------------------------------------
{
  const teamUi = await script(handleTelegramCenterV15TeamUi, "/telegram-app/v15-team.js");
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test/telegram-app-v24", runScripts: "outside-only" });
  const { window } = dom;
  window.eval(`
    var H = { esc: ${esc.toString()}, teamLogo: function (t) { return 'https://l.test/' + t + '.svg'; } };
    function timeText() { return '13.10, 03:00'; }
    function playoffRound() { return 'Регулярка'; }
    function seriesScore() { return ''; }
    ${lineOf(teamUi, "function score(g,tri)")}
    ${lineOf(teamUi, "function ensureResCss()")}
    ${lineOf(teamUi, "function gameCard(g,tri,map,schedule)")}
    window.gameCard = gameCard;
  `);
  const map = { VGK: { name: "Вегас Голден Найтс", logo: "https://l.test/VGK.svg" }, MIN: { name: "Миннесота Уайлд", logo: "https://l.test/MIN.svg" } };
  const card = (g, tri) => {
    const box = window.document.createElement("div");
    box.innerHTML = window.gameCard(g, tri, map, []);
    return box.firstElementChild;
  };
  const base = { game_pk: 1, scheduled_start_utc: "2026-10-13T00:00:00Z", game_state: "OFF", home_tri: "MIN", away_tri: "VGK", home_score: 4, away_score: 2, period_type: "REG" };
  const win = card(base, "MIN");
  assert.equal(text(win.querySelector(".res")), "В", "a win");
  assert.ok(win.querySelector(".res").classList.contains("w"));
  assert.equal(text(win.querySelector(".ha")), "vs", "at home");
  assert.equal(text(win.querySelector(".score")), "В4 : 2");
  const loss = card(base, "VGK");
  assert.equal(text(loss.querySelector(".res")), "П", "the same game for the other team is a loss");
  assert.ok(loss.querySelector(".res").classList.contains("l"));
  assert.equal(text(loss.querySelector(".ha")), "@", "away");
  assert.equal(text(loss.querySelector(".score")), "П2 : 4");
  const otLoss = card({ ...base, period_type: "OT", home_score: 3, away_score: 2 }, "VGK");
  assert.equal(text(otLoss.querySelector(".res")), "ПО", "a loss in overtime");
  assert.ok(otLoss.querySelector(".res").classList.contains("o"));
  assert.match(text(otLoss.querySelector(".score")), /ПО2 : 3 ОТ/, "and the score says OT");
  assert.match(text(card({ ...base, period_type: "SO", home_score: 3, away_score: 2 }, "MIN").querySelector(".score")), /В3 : 2 Б/, "a win in a shootout");
  const ahead = card({ ...base, game_state: "FUT", home_score: null, away_score: null }, "MIN");
  assert.ok(!ahead.querySelector(".res"), "a game that has not been played has no mark");
  assert.equal(text(ahead.querySelector(".score")), "—");
  assert.equal(text(ahead.querySelector(".ha")), "vs");
  assert.match(window.document.getElementById("v15ResCss").textContent, /\.hohNoSpoilers \.v15Game \.res\{display:none!important\}/, "the mark is hidden in no-spoilers mode");
  window.close();
}

// ---- 3) players tab: by points first, the numbers in the row -----------------------------------------------------------------
{
  const v8 = await script(handleTelegramCenterV8Ui, "/telegram-app");
  assert.match(v8, /playerSort:'points',playerLimit:10,country:'RUS'/, "by points first");
  assert.match(v8, /Сортировка: '\+esc\(playerSortLabel\(state\.playerSort\)\)/, "the sort control names the current sort");
  assert.match(v8, /'<\/small>'\+playerStatLine\(p\)\+'<\/div><span class="playerSortValue">'/, "the line is part of every row of the list");
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(`
    var esc = ${esc.toString()};
    ${lineOf(v8, "function playerStatLine(p)")}
    window.playerStatLine = playerStatLine;
  `);
  const line = (p) => text((() => { const b = dom.window.document.createElement("div"); b.innerHTML = dom.window.playerStatLine(p); return b; })());
  assert.equal(line({ position_code: "L", games_played: 6, goals: 6, assists: 3, points: 9 }), "И 6 · Г 6 · П 3 · О 9", "games, goals, assists, points");
  assert.equal(line({ position_code: "G", games_played: 6, goals: 0, assists: 0, points: 0 }), "", "a goalie has no skater line");
  assert.equal(line({ position_code: "C", points: null }), "", "no stats yet: nothing");
  assert.equal(line({ position_code: "D", points: 0 }), "И 0 · Г 0 · П 0 · О 0", "a skater without points still shows the line");
  dom.window.close();
}

console.log("home follow-ups validation passed");
