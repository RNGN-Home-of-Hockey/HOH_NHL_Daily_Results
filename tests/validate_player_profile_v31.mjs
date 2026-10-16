// v31: the portrait of a player — the hexagon on his page. The main layer is the game NHL 27 (the averages of its main groups of
// characteristics), and two layers to press: the season and the five seasons, the real numbers under the same axes (the share of
// the players of his position he is better than). Plus the bright tendencies, the short Winline card and the season stats by
// category with the strongest numbers first. The NHL stats API and the EA site are faked, D1 runs on SQLite with the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import {
  SCRIPT_PATH, SKATER_AXES, GOALIE_AXES, EA_SKATER_GROUPS, EA_GOALIE_GROUPS, EA_GOALIE_AXES, MIN_GAMES, MIN_FIVE_GAMES, FIVE_KEY,
  percentile, groupOf, gamePositionGroup, currentSeason, lastSeasons, computeProfiles, layerOf, gameGroups, gameLayer, matchGamePlayers,
  runPlayerProfileMaintenance, refreshGameRatings, handleTelegramCenterV31,
} from "../cloudflare-worker/src/telegram-center-v31-player-profile.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";
import { literal, inline, ratingsSql } from "../tools/import_game_ratings.mjs";
import { handleTelegramCenterV23PlayerUi } from "../cloudflare-worker/src/telegram-center-v23-player-ui.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const lineOf = (source, start) => {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  return source.slice(i, source.indexOf("\n", i));
};

// ---- 1) the axes and the numbers ---------------------------------------------------------------------------------------------------------
assert.equal(percentile(5, []), null, "nobody to compare with");
assert.equal(percentile(10, [1, 2, 3, 10]), 88, "better than 3, equal to himself (a tie counts half)");
assert.equal(percentile(0, [0, 0, 0, 0]), 50, "all equal: the middle, not the bottom");
assert.equal(percentile(1, [2, 3]), 0);
assert.equal(percentile(9, [2, 3]), 100);
assert.deepEqual(["C", "L", "R", "D", "G", "", null].map(groupOf), ["F", "F", "F", "D", "G", "F", "F"]);
assert.deepEqual(["CEN", "LW", "RW", "LD", "RD", "G", "", null].map(gamePositionGroup), ["F", "F", "F", "D", "D", "G", "F", "F"], "the game writes LD/RD for a defenceman");
assert.equal(currentSeason(Date.parse("2026-10-14T12:00:00Z")), "20262027");
assert.equal(currentSeason(Date.parse("2027-03-01T12:00:00Z")), "20262027");
assert.equal(currentSeason(Date.parse("2026-09-01T00:00:00Z")), "20262027", "the season starts with the camps");
assert.equal(currentSeason(Date.parse("2026-08-31T23:00:00Z")), "20252026");
assert.deepEqual(lastSeasons("20262027"), ["20262027", "20252026", "20242025", "20232024", "20222023"], "five seasons, this one included");
assert.equal(MIN_GAMES, 5, "the owner: the season portrait from the 5th game");
assert.equal(MIN_FIVE_GAMES, 82, "five seasons: at least a full season of games");
// the axes are the main groups of the game, and the season numbers sit under the same axes
assert.deepEqual(SKATER_AXES.map((a) => a.label), ["Катание", "Атака", "Владение шайбой", "Оборона", "Физика", "Общие"]);
assert.deepEqual(SKATER_AXES.map((a) => a.key), Object.keys(EA_SKATER_GROUPS), "one axis = one group of the game");
assert.deepEqual(EA_GOALIE_AXES.map((a) => a.key), Object.keys(EA_GOALIE_GROUPS));
assert.deepEqual(EA_GOALIE_AXES.map((a) => a.label), ["Верх", "Низ", "Позиция", "Добивания", "Выходы один на один", "Катание"]);
assert.deepEqual(GOALIE_AXES.map((a) => a.label), ["Отражения", "Надёжность", "Победы", "Нагрузка", "Сухие"]);
{
  // every rating named is one the game publishes (a typo would silently drop it from the average)
  const GAME = "acceleration,agility,jumping,stamina,strength,aggression,balance,bodyChecking,defensiveAwareness,handeye,deking,discipline,durability,endurance,faceoffs,offensiveAwareness,passing,poise,puckControl,shotBlocking,slapshotAccuracy,slapshotPower,speed,fightingSkill,stickChecking,wristshotAccuracy,wristshotPower,shotRecover,glovesideHigh,glovesideLow,sticksideHigh,sticksideLow,fiveHole,pokeCheck,angles,reboundControl,breakaway,puckplayingFrequency,aggressiveness,vision".split(",");
  for (const attrs of [...Object.values(EA_SKATER_GROUPS), ...Object.values(EA_GOALIE_GROUPS)]) for (const a of attrs) assert.ok(GAME.includes(a), `not a rating of the game: ${a}`);
  assert.equal(new Set(Object.values(EA_SKATER_GROUPS).flat()).size, 25, "the 25 skater ratings of the six groups, none twice");
}
// the game's ratings → the group averages
const STAR = { acceleration: 95, agility: 94, balance: 88, endurance: 90, speed: 93, offensiveAwareness: 96, slapshotAccuracy: 90, slapshotPower: 92, wristshotAccuracy: 95, wristshotPower: 94, deking: 92, handeye: 94, passing: 88, puckControl: 93, defensiveAwareness: 70, shotBlocking: 60, stickChecking: 77, aggression: 70, bodyChecking: 72, fightingSkill: 50, strength: 84, discipline: 84, durability: 88, faceoffs: 0, poise: 92 };
const STAR_GROUPS = [92, 93, 92, 69, 69, 88];
{
  assert.deepEqual(gameGroups(STAR, false), { skating: 92, offense: 93, puck: 92, defense: 69, physical: 69, general: 88 }, "the average of each group; a zero (a winger's faceoffs not rated) is left out");
  assert.deepEqual(gameGroups({}, false), { skating: null, offense: null, puck: null, defense: null, physical: null, general: null }, "nothing rated: null, not 0");
  assert.deepEqual(Object.keys(gameGroups({ glovesideHigh: 90 }, true)), ["high", "low", "position", "rebounds", "breakaway", "skating"]);
  assert.equal(gameGroups({ glovesideHigh: 90, sticksideHigh: 85 }, true).high, 88);
  const layer = gameLayer({ game: "NHL 27", overall: 97, position: "LW", groups_json: JSON.stringify(gameGroups(STAR, false)) });
  assert.deepEqual(layer, { game: "NHL 27", overall: 97, axes: SKATER_AXES.map((a, i) => ({ key: a.key, label: a.label, value: STAR_GROUPS[i] })) });
  assert.deepEqual(gameLayer({ game: "NHL 27", overall: 90, position: "G", groups_json: "{}" }).axes.map((a) => a.label), EA_GOALIE_AXES.map((a) => a.label));
  assert.equal(gameLayer({ game: "NHL 27", overall: 90, position: "G", groups_json: "{" }), null, "a broken row: no layer, not a crash");
  assert.equal(gameLayer(null), null);
}

// the league in miniature: 5 forwards (one of 2 games, one of exactly 5), 3 defencemen, 4 goalies
const sk = (playerId, positionCode, gamesPlayed, goals, assists, shots, timeOnIcePerGame) => ({ playerId, positionCode, gamesPlayed, goals, assists, shots, timeOnIcePerGame });
const SUMMARY = [
  sk(1, "L", 7, 8, 3, 25, 1266), // the star (Kaprizov-like)
  sk(2, "C", 7, 2, 6, 14, 1100),
  sk(3, "R", 7, 0, 1, 7, 700),
  sk(4, "C", 2, 1, 0, 3, 900), // two games only: measured, but not a yardstick for the others
  sk(8, "C", 5, 1, 1, 6, 800), // exactly 5 games: a yardstick
  sk(5, "D", 7, 1, 5, 20, 1500),
  sk(6, "D", 7, 0, 1, 8, 1200),
  sk(7, "D", 7, 0, 0, 4, 1000),
];
const REALTIME = [
  { playerId: 1, hits: 3, blockedShots: 2, takeaways: 6 }, { playerId: 2, hits: 10, blockedShots: 4, takeaways: 3 }, { playerId: 3, hits: 20, blockedShots: 5, takeaways: 1 },
  { playerId: 8, hits: 5, blockedShots: 1, takeaways: 0 }, { playerId: 5, hits: 6, blockedShots: 15, takeaways: 4 }, { playerId: 6, hits: 14, blockedShots: 9, takeaways: 2 },
];
const EDGE = new Map([[1, { speedMax: 23.9, bursts: 14 }], [2, { speedMax: 22.1, bursts: 3 }], [3, { speedMax: 22.8, bursts: 7 }], [5, { speedMax: 23.0, bursts: 5 }]]);
const GOALIES = [
  { playerId: 31, gamesPlayed: 6, gamesStarted: 6, wins: 3, shutouts: 1, savePct: 0.912, goalsAgainstAverage: 2.46 },
  { playerId: 32, gamesPlayed: 5, gamesStarted: 5, wins: 1, shutouts: 0, savePct: 0.889, goalsAgainstAverage: 3.4 },
  { playerId: 33, gamesPlayed: 5, gamesStarted: 4, wins: 2, shutouts: 0, savePct: 0.925, goalsAgainstAverage: 2.1 },
  { playerId: 34, gamesPlayed: 0, gamesStarted: 0, wins: 0, shutouts: 0, savePct: 0, goalsAgainstAverage: 0 }, // has not played: no portrait
];
const profiles = computeProfiles({ summary: SUMMARY, realtime: REALTIME, goalies: GOALIES, edge: EDGE });
const P = (id) => profiles.find((p) => p.player_id === id);
assert.deepEqual(profiles.map((p) => p.player_id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 31, 32, 33], "everybody who played, nobody else");
assert.deepEqual([P(1).pos_group, P(5).pos_group, P(31).pos_group], ["F", "D", "G"]);
assert.equal(P(1).peers, 4, "forwards are compared with the forwards of 5+ games (the one of 5 counts, the one of 2 does not)");
assert.equal(P(4).peers, 4, "the forward of two games is measured against them");
assert.equal(P(5).peers, 3, "defencemen with defencemen");
assert.equal(P(31).peers, 3);
assert.deepEqual(Object.keys(P(1).axes), ["skating", "offense", "puck", "defense", "physical", "general"]);
assert.equal(P(1).axes.offense, 88, "the most goals and the most shots a game");
assert.equal(P(3).axes.offense, 13, "no goals, the fewest shots");
assert.equal(P(1).axes.skating, 83, "the top speed and the most bursts (the forward without EDGE data is not a yardstick)");
assert.equal(P(8).axes.skating, null, "not measured by EDGE: no skating, not a zero");
assert.equal(P(1).axes.puck, 63, "assists: the second of four");
assert.equal(P(1).axes.defense, 88, "takeaways and blocks a game");
assert.equal(P(1).axes.physical, 13, "the star does not hit");
assert.equal(P(3).axes.physical, 88);
assert.equal(P(1).axes.general, 88, "the most ice time");
assert.equal(P(5).axes.puck, 83, "the defenceman is not compared with the forwards");
assert.equal(P(7).axes.physical, 17, "nobody in the hits report: zero hits, not a crash");
assert.equal(P(33).axes.save, 83, "the best save percentage");
assert.equal(P(33).axes.gaa, 83, "fewer goals against is better");
assert.equal(P(32).axes.gaa, 17);
assert.equal(P(31).axes.load, 83, "the most starts");
{
  const few = computeProfiles({ summary: SUMMARY, realtime: REALTIME, goalies: GOALIES, edge: EDGE }, { minGames: 8 });
  assert.equal(few.find((p) => p.player_id === 1).axes.offense, null, "nobody with enough games: no percentile, not a fake one");
  assert.equal(layerOf(few.find((p) => p.player_id === 1), SKATER_AXES)[1].text, "", "and no words under an empty axis");
}

// ---- 2) the numbers behind the axes, in words ----------------------------------------------------------------------------------------------
{
  const t = Object.fromEntries(layerOf(P(1), SKATER_AXES).map((a) => [a.key, a.text]));
  assert.deepEqual(t, {
    skating: "до 38,5 км/ч · 2 рывка быстрее 32 км/ч за матч",
    offense: "1,14 гола и 3,6 броска за матч",
    puck: "0,43 передачи за матч",
    defense: "1,1 отбора или блока за матч",
    physical: "0,4 силового приёма за матч",
    general: "21:06 на льду за матч",
  });
  assert.deepEqual(layerOf(P(1), SKATER_AXES).map((a) => a.pct), [83, 88, 63, 88, 13, 88]);
  assert.equal(layerOf(P(8), SKATER_AXES)[0].text, "скорость ещё не измерена");
  assert.equal(layerOf(P(8), SKATER_AXES)[0].pct, null);
  const g = Object.fromEntries(layerOf(P(31), GOALIE_AXES).map((a) => [a.key, a.text]));
  assert.deepEqual(g, { save: "91,2% отражённых бросков", gaa: "пропускает 2,46 гола за матч", wins: "3 победы в 6 матчах", load: "6 стартов", shutouts: "1 сухой матч" });
  // the word after a number: a fraction takes the genitive singular, a whole number its own form
  const r = (o) => ({ gp: 1, goals: 0, shots: 0, assists: 0, takeaways: 0, blocks: 0, hits: 0, toi: 0, speedMax: null, bursts: null, ...o });
  const [skating, offense, puck, defense, physical] = SKATER_AXES;
  assert.deepEqual([1, 2, 5, 0, 21].map((n) => offense.text(r({ goals: n, shots: 1 }))), ["1 гол и 1 бросок за матч", "2 гола и 1 бросок за матч", "5 голов и 1 бросок за матч", "0 голов и 1 бросок за матч", "21 гол и 1 бросок за матч"]);
  assert.deepEqual([1, 2, 5, 0.5].map((n) => puck.text(r({ assists: n }))), ["1 передача за матч", "2 передачи за матч", "5 передач за матч", "0,5 передачи за матч"]);
  assert.deepEqual([1, 2, 5, 0.4].map((n) => physical.text(r({ hits: n }))), ["1 силовой приём за матч", "2 силовых приёма за матч", "5 силовых приёмов за матч", "0,4 силового приёма за матч"]);
  assert.deepEqual([1, 3, 10].map((n) => defense.text(r({ takeaways: n }))), ["1 отбор или блок за матч", "3 отбора или блока за матч", "10 отборов и блоков за матч"]);
  assert.equal(skating.text(r({ speedMax: 22.5 })), "до 36,2 км/ч", "no bursts known: the speed alone");
  assert.equal(skating.text(r({ speedMax: 22.5, bursts: 5, gp: 1 })), "до 36,2 км/ч · 5 рывков быстрее 32 км/ч за матч");
  assert.equal(GOALIE_AXES[1].text({ gaa: 1 }), "пропускает 1 гол за матч");
  assert.equal(GOALIE_AXES[2].text({ wins: 1, gp: 1 }), "1 победа в 1 матче");
  assert.equal(GOALIE_AXES[4].text({ shutouts: 5 }), "5 сухих матчей");
}

// ---- 3) the game's players → NHL ids ------------------------------------------------------------------------------------------------------
const TEAMS = [["MIN", "Minnesota Wild"], ["VAN", "Vancouver Canucks"], ["CAR", "Carolina Hurricanes"], ["NYI", "New York Islanders"], ["MTL", "Montréal Canadiens"], ["NYR", "New York Rangers"], ["VGK", "Vegas Golden Knights"], ["PHI", "Philadelphia Flyers"]];
const PLAYERS = [
  [1, "Kirill", "Kaprizov", "MIN", 97], [5, "Quinn", "Hughes", "VAN", 43], [31, "Igor", "Shesterkin", "NYR", 31],
  [25, "Elias", "Pettersson", "VAN", 25], [40, "Elias", "Pettersson", "VAN", 40], [65, "Marcus", "Pettersson", "VAN", 65], // two namesakes in one team (the wrong one first)
  [21, "Sebastian", "Aho", "NYI", 25], [20, "Sebastian", "Aho", "CAR", 20], // namesakes in two teams
  [14, "Nick", "Suzuki", "MTL", 14], [16, "Mitchell", "Marner", "VGK", 93], // «Mitch» in the game
  [8477934, "Leon", "Draisaitl", "PHI", 29], // a rating of the game, no games this season
];
const playerRows = PLAYERS.map(([player_id, first, last, tri, num]) => ({ player_id, first_name_en: first, last_name_en: last, full_name_en: `${first} ${last}`, current_team_tri: tri, sweater_number: num }));
const ea = (id, firstName, lastName, team, jerseyNum, pos, overallRating, stats = {}) => ({ id, firstName, lastName, team: { label: team }, jerseyNum, position: { shortLabel: pos }, overallRating, stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { value: v }])) });
const EA_ITEMS = [
  ea(9001, "Kirill", "Kaprizov", "Minnesota Wild", 97, "LW", 97, STAR),
  ea(9002, "Quinn", "Hughes", "Vancouver Canucks", 43, "LD", 93, { acceleration: 92, speed: 91 }),
  ea(9003, "Igor", "Shesterkin", "New York Rangers", 31, "G", 95, { glovesideHigh: 94, sticksideHigh: 92, angles: 93, vision: 95, agility: 90, speed: 80, endurance: 85 }),
  ea(9004, "Elias", "Pettersson", "Vancouver Canucks", 40, "CEN", 89),
  ea(9005, "Sebastian", "Aho", "Carolina Hurricanes", 20, "CEN", 90),
  ea(9006, "Nick", "Suzuki", "Montreal Canadiens", 14, "CEN", 88), // the game writes Montreal without the accent
  ea(9007, "Mitch", "Marner", "Vegas Golden Knights", 93, "RW", 91),
  ea(9008, "Leon", "Draisaitl", "Philadelphia Flyers", 29, "CEN", 95),
  ea(9009, "Some", "Prospect", "Minnesota Wild", 77, "LW", 80), // not in our players: left out
];
{
  const { matched, missed } = matchGamePlayers(EA_ITEMS, playerRows, TEAMS.map(([tri_code, name_en]) => ({ tri_code, name_en })));
  const by = Object.fromEntries(matched.map((m) => [m.item.id, m.player_id]));
  assert.equal(by[9001], 1);
  assert.equal(by[9004], 40, "Elias Pettersson the forward, by his number (the defenceman of the same name is #25)");
  assert.equal(by[9005], 20, "Sebastian Aho of Carolina, not the one of the Islanders");
  assert.equal(by[9006], 14, "Montreal = Montréal");
  assert.equal(by[9007], 16, "Mitch = Mitchell: the last name in the same team");
  assert.equal(matched.find((m) => m.item.id === 9006).tri, "MTL");
  assert.deepEqual(missed, ["Some Prospect"]);
}

// ---- 4) the maintenance: the league every 6 hours, the game once a week, a pause when a source is down -------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const createOf = (file, table) => fs.readFileSync(new URL(file, MIG), "utf8").match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(createOf("0051_player_season_profiles.sql", "player_season_profiles"));
raw.exec(createOf("0057_player_game_ratings.sql", "player_game_ratings"));
raw.exec(createOf("0023_nhl_edge_tracking.sql", "nhl_edge_features"));
raw.exec(createOf("0001_hoh_data_core.sql", "teams"));
raw.exec(createOf("0001_hoh_data_core.sql", "players"));
for (const [tri, name] of TEAMS) raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(tri, name);
for (const p of playerRows) raw.prepare("INSERT INTO players(player_id,first_name_en,last_name_en,full_name_en,current_team_tri,sweater_number) VALUES(?,?,?,?,?,?)").run(p.player_id, p.first_name_en, p.last_name_en, p.full_name_en, p.current_team_tri, p.sweater_number);
const edgeRow = (season, type, id, speed, bursts, gameType = 2) => raw.prepare("INSERT INTO nhl_edge_features(season_id,game_type,entity_type,entity_id,skating_speed_max_mph,bursts_over_20) VALUES(?,?,?,?,?,?)").run(season, gameType, type, id, speed, bursts);
for (const [id, e] of EDGE) edgeRow("20262027", "skater", id, e.speedMax, e.bursts);
edgeRow("20252026", "skater", 1, 24.4, 60); // his best speed was last season
edgeRow("20252026", "skater", 2, 30.0, 9, 3); // the playoffs: not the regular season
edgeRow("20192020", "skater", 3, 29.0, 9); // older than five seasons
edgeRow("20252026", "skater", 8, 21.5, 2); // measured last season, not yet this one
edgeRow("20262027", "goalie", 31, 19.0, 0);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const db = { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } };
const env = { DB: db };

// a whole league: 150 more skaters and 20 goalies; the five seasons are the same players with 40 times the games
const LEAGUE = {
  summary: [...SUMMARY, ...Array.from({ length: 150 }, (_, i) => sk(100 + i, i % 3 ? "C" : "D", 6, i % 5, i % 7, i % 9, 900 + i * 3))],
  realtime: [...REALTIME, ...Array.from({ length: 150 }, (_, i) => ({ playerId: 100 + i, hits: i % 11, blockedShots: i % 6, takeaways: i % 4 }))],
  timeonice: Array.from({ length: 150 }, (_, i) => ({ playerId: 100 + i, timeOnIcePerGame: 900 + i * 3 })),
  goalies: [...GOALIES, ...Array.from({ length: 20 }, (_, i) => ({ playerId: 500 + i, gamesPlayed: 6, gamesStarted: 6, wins: i % 4, shutouts: i % 2, savePct: 0.88 + i / 1000, goalsAgainstAverage: 2 + i / 10 }))],
};
const times = (list, keys) => list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, keys.includes(k) ? v * 40 : v])));
const LEAGUE5 = {
  summary: times(LEAGUE.summary, ["gamesPlayed", "goals", "assists", "shots"]),
  realtime: times(LEAGUE.realtime, ["hits", "blockedShots", "takeaways"]),
  goalies: times(LEAGUE.goalies, ["gamesPlayed", "gamesStarted", "wins", "shutouts"]),
};
const nhl = { down: false, asked: [], skaters: null, five: null };
const site = { down: false, asked: [], build: "TestBuild_123", short: false };
const fill = (from, count) => Array.from({ length: count }, (_, i) => ea(20000 + from + i, "Filler", `Nobody${from + i}`, "Minnesota Wild", 0, "CEN", 70));
const page = (n) => site.short ? { pageProps: { ratingDetails: { totalItems: EA_ITEMS.length, items: n === 1 ? EA_ITEMS : [] } } } : ({ pageProps: { ratingDetails: { totalItems: EA_ITEMS.length + 100, items: n === 1 ? EA_ITEMS.concat(fill(0, 41)) : n === 2 ? fill(41, 50) : n === 3 ? fill(91, 9) : [] } } });
const fetcher = async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "www.ea.com") {
    site.asked.push(u.pathname + u.search);
    if (site.down) return new Response("denied", { status: 403 });
    if (u.pathname === "/games/nhl/ratings") return new Response(`<html><title>NHL 24 → NHL 27</title><p>NHL 27 ratings, NHL 27 ratings, NHL 26</p><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ buildId: site.build, page: "/games/nhl/ratings" })}</script></html>`, { status: 200 });
    assert.match(u.pathname, new RegExp(`^/_next/data/${site.build}/en/games/nhl/ratings\\.json$`), "the data route of the build the page named");
    return new Response(JSON.stringify(page(Number(u.searchParams.get("page")))), { status: 200 });
  }
  nhl.asked.push(url);
  assert.equal(init.headers.Accept, "application/json");
  if (nhl.down) throw new Error("timeout");
  assert.equal(u.searchParams.get("limit"), "-1", "the whole league in one page");
  const report = u.pathname.replace("/stats/rest/en/", "");
  const five = u.searchParams.get("isAggregate") === "true";
  assert.equal(u.searchParams.get("cayenneExp"), five ? "seasonId>=20222023 and seasonId<=20262027 and gameTypeId=2" : "seasonId=20262027 and gameTypeId=2", "the regular season of now, or the five regular seasons together");
  const data = five
    ? { "skater/summary": nhl.five || LEAGUE5.summary, "skater/realtime": LEAGUE5.realtime, "goalie/summary": LEAGUE5.goalies }[report]
    : { "skater/summary": nhl.skaters || LEAGUE.summary, "skater/realtime": LEAGUE.realtime, "skater/timeonice": LEAGUE.timeonice, "goalie/summary": LEAGUE.goalies }[report];
  assert.ok(data, `unexpected report ${report} ${five ? "(five seasons)" : ""}`);
  return new Response(JSON.stringify({ data }), { status: 200 });
};
const NOW = Date.parse("2026-10-14T20:00:00Z");
const rows = (season) => raw.prepare("SELECT COUNT(*) AS n FROM player_season_profiles WHERE season_id=?").get(season).n;
const setMetaTime = (key, at) => raw.prepare("UPDATE data_core_meta SET updated_at=? WHERE meta_key=?").run(at, key);
const meta = (key) => raw.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key=?").get(key)?.meta_value;
const seasonAxes = (id) => JSON.parse(raw.prepare("SELECT axes_json FROM player_season_profiles WHERE season_id='20262027' AND player_id=?").get(id).axes_json);
{
  assert.deepEqual(await runPlayerProfileMaintenance({}), { ok: false, error: "missing_d1_binding" });
  const r1 = await runPlayerProfileMaintenance(env, { now: NOW, fetcher });
  assert.deepEqual(r1, { ok: true, season: "20262027", players: 181, five: 181, game: { ok: true, game: "NHL 27", players: 8, missed: 101 } }, "158 skaters and 23 goalies who played; 8 of the game's players found");
  assert.equal(rows("20262027"), 181);
  assert.equal(rows(FIVE_KEY), 181, "the five seasons kept beside the season");
  assert.equal(nhl.asked.length, 7, "four reports of the season, three of the five seasons");
  assert.deepEqual(site.asked, ["/games/nhl/ratings", ...[1, 2, 3].map((n) => `/_next/data/TestBuild_123/en/games/nhl/ratings.json?franchiseSlug=nhl&page=${n}`)], "the page, then the list until it is whole");
  const row = raw.prepare("SELECT * FROM player_season_profiles WHERE season_id='20262027' AND player_id=1").get();
  assert.equal(row.pos_group, "F");
  assert.equal(row.games, 7);
  assert.ok(row.peers > 100, "compared with the whole league");
  const axes = JSON.parse(row.axes_json);
  assert.deepEqual(Object.keys(axes), ["skating", "offense", "puck", "defense", "physical", "general"]);
  assert.ok(axes.offense > 95, "8 goals in 7 games: the top of the league");
  assert.equal(JSON.parse(row.values_json).raw.speedMax, 23.9, "the EDGE speed of this season");
  const five = (id) => JSON.parse(raw.prepare(`SELECT values_json FROM player_season_profiles WHERE season_id='${FIVE_KEY}' AND player_id=?`).get(id).values_json).raw;
  assert.equal(five(1).speedMax, 24.4, "five seasons: his best top speed");
  assert.equal(five(1).bursts, null, "bursts are per season: not added up across seasons");
  assert.equal(five(2).speedMax, 22.1, "a playoff run is not the regular season");
  assert.equal(five(3).speedMax, 22.8, "a season older than five is not counted");
  assert.equal(five(1).gp, 280);
  const game = raw.prepare("SELECT * FROM player_game_ratings WHERE player_id=1").get();
  assert.deepEqual({ ...game, fetched_at: "x" }, { player_id: 1, game: "NHL 27", ea_id: 9001, ea_name: "Kirill Kaprizov", team_tri: "MIN", position: "LW", overall: 97, groups_json: JSON.stringify(gameGroups(STAR, false)), fetched_at: "x" }, "the game named most on the page, the group averages, not the whole sheet");
  assert.deepEqual(JSON.parse(raw.prepare("SELECT groups_json FROM player_game_ratings WHERE player_id=31").get().groups_json), { high: 93, low: null, position: 94, rebounds: null, breakaway: null, skating: 85 }, "a goalie: the goalie groups");
  assert.equal(JSON.parse(meta("player_game_ratings_v1")).missed.length, 40, "the names not found are kept for a look (the first 40)");

  nhl.asked.length = 0;
  site.asked.length = 0;
  setMetaTime("player_profiles_v31b", "2026-10-14 19:00:00");
  assert.deepEqual(await runPlayerProfileMaintenance(env, { now: NOW, fetcher }), { ok: true, skipped: true, reason: "fresh", game: { ok: true, skipped: true, reason: "fresh" } });
  assert.equal(nhl.asked.length + site.asked.length, 0, "fresh: neither the NHL nor EA is asked every 5 minutes");

  setMetaTime("player_profiles_v31b", "2026-10-14 13:30:00"); // the last good run 6.5 hours ago
  raw.prepare("UPDATE data_core_meta SET meta_value=? WHERE meta_key='player_profiles_v31b_try'").run(String(NOW - 6.5 * 3600 * 1000));
  nhl.down = true;
  await assert.rejects(runPlayerProfileMaintenance(env, { now: NOW, fetcher }), /timeout/, "an honest failure for the log of the cron");
  assert.equal(rows("20262027"), 181, "the portraits of before stay");
  nhl.asked.length = 0;
  assert.equal((await runPlayerProfileMaintenance(env, { now: NOW + 5 * 60 * 1000, fetcher })).reason, "retry_later");
  assert.equal(nhl.asked.length, 0, "the NHL down: the next try in half an hour, not in 5 minutes");
  nhl.down = false;
  const r2 = await runPlayerProfileMaintenance(env, { now: NOW + 31 * 60 * 1000, fetcher });
  assert.equal(r2.ok, true);
  assert.equal(r2.players, 181);

  nhl.skaters = SUMMARY;
  const r3 = await runPlayerProfileMaintenance(env, { now: NOW + 40 * 60 * 1000, fetcher, force: true });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, "nhl_stats_incomplete", "a cut report does not rewrite the league with 8 players");
  nhl.skaters = null;
  assert.equal(seasonAxes(1).offense, axes.offense);
  nhl.five = LEAGUE5.summary.slice(0, 50);
  const r3b = await runPlayerProfileMaintenance(env, { now: NOW + 45 * 60 * 1000, fetcher, force: true });
  assert.deepEqual([r3b.ok, r3b.players, r3b.five], [true, 181, 0], "a cut report of the five seasons: the season is made, the five seasons are not rewritten");
  nhl.five = null;
  assert.equal(rows(FIVE_KEY), 181);
  assert.equal(five(1).gp, 280, "the five seasons of before stay");

  // the game: a week later again; EA closed — the season portraits are still made, the next try in 12 hours
  const WEEK = NOW + 7 * 86400 * 1000 + 60 * 1000;
  site.asked.length = 0;
  site.down = true;
  const r4 = await runPlayerProfileMaintenance(env, { now: WEEK, fetcher });
  assert.equal(r4.ok, true, "EA closed does not stop the season portraits");
  assert.equal(r4.players, 181);
  assert.deepEqual(r4.game, { ok: false, error: "ea_ratings_403" });
  assert.equal(raw.prepare("SELECT overall FROM player_game_ratings WHERE player_id=1").get().overall, 97, "the ratings of before stay");
  site.asked.length = 0;
  assert.deepEqual(await refreshGameRatings(env, { now: WEEK + 3600 * 1000, fetcher }), { ok: true, skipped: true, reason: "retry_later" });
  assert.equal(site.asked.length, 0, "EA closed: not asked every 5 minutes");
  site.down = false;
  site.build = "NewBuild_456";
  const r5 = await refreshGameRatings(env, { now: WEEK + 13 * 3600 * 1000, fetcher });
  assert.equal(r5.ok, true);
  assert.equal(r5.players, 8, "a new build of the site: the page names it, the data route follows");
  assert.deepEqual(await refreshGameRatings({}), { ok: false, error: "missing_d1_binding" });
  site.short = true;
  await assert.rejects(refreshGameRatings(env, { now: WEEK + 14 * 3600 * 1000, fetcher, force: true }), /ea_ratings_incomplete_9/, "a cut list of the game (9 of 300) does not replace the ratings");
  site.short = false;
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM player_game_ratings").get().n, 8);
}

// ---- 4b) the same rows written from GitHub Actions (EA's site did not give the ratings to the Worker) ----------------------------------------
{
  assert.equal(literal("Ryan O'Reilly"), "'Ryan O''Reilly'");
  assert.deepEqual([literal(null), literal(undefined), literal(NaN), literal(97)], ["NULL", "NULL", "NULL", "97"]);
  assert.equal(inline("VALUES(?,?)", [1, "a?b"]), "VALUES(1,'a?b')", "a ? inside a value is not a placeholder");
  const extra = { player_id: 90, first_name_en: "Ryan", last_name_en: "O'Reilly", full_name_en: "Ryan O'Reilly", current_team_tri: "MIN", sweater_number: 90 };
  const items = [...EA_ITEMS, ea(9010, "Ryan", "O'Reilly", "Minnesota Wild", 90, "CEN", 88, { passing: 90 })];
  const { sql, result } = await ratingsSql({ game: "NHL 27", items }, [...playerRows, extra], TEAMS.map(([tri_code, name_en]) => ({ tri_code, name_en })), NOW);
  assert.deepEqual(result, { ok: true, game: "NHL 27", players: 9, missed: 1 });
  const other = new DatabaseSync(":memory:");
  other.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
  other.exec(createOf("0057_player_game_ratings.sql", "player_game_ratings"));
  other.exec(sql);
  assert.equal(other.prepare("SELECT ea_name FROM player_game_ratings WHERE player_id=90").get().ea_name, "Ryan O'Reilly", "a name with an apostrophe is written whole");
  assert.deepEqual({ ...other.prepare("SELECT groups_json,overall,team_tri FROM player_game_ratings WHERE player_id=1").get() }, { groups_json: JSON.stringify(gameGroups(STAR, false)), overall: 97, team_tri: "MIN" }, "the same rows as the Worker writes");
  assert.equal(JSON.parse(other.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key='player_game_ratings_v1'").get().meta_value).players, 9, "and the mark that keeps the Worker from asking EA for a week");
  const flow = fs.readFileSync(new URL("../.github/workflows/import-game-ratings.yml", import.meta.url), "utf8");
  assert.match(flow, /run: node tools\/import_game_ratings\.mjs/);
  assert.match(flow, /schedule:\s*\n\s*- cron: "20 6 \* \* 1,4"/, "twice a week: inside the Worker's 7 days of freshness");
}

// ---- 5) the API, the script and the card on the player page --------------------------------------------------------------------------------
{
  // a rating of the game for a player with no games this season (outside the stats reports)
  raw.prepare("INSERT INTO player_game_ratings(player_id,game,ea_id,ea_name,team_tri,position,overall,groups_json,fetched_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET groups_json=excluded.groups_json")
    .run(8477934, "NHL 27", 9008, "Leon Draisaitl", "PHI", "CEN", 95, JSON.stringify({ skating: 88, offense: 95 }), "2026-10-14T20:00:00.000Z");
  // the day of the test: the season 2026/27 is the current one (the game's layer and the five seasons belong to it only)
  const get = (path, method = "GET") => handleTelegramCenterV31(new Request(`https://x.test${path}`, { method }), env, new URL(`https://x.test${path}`).pathname, { now: NOW });
  const season = currentSeason(NOW);
  assert.equal(await get("/api/other"), null);
  assert.equal(await get("/api/telegram-center-v31/players/abc/profile"), null, "only numeric ids");
  assert.equal((await get("/api/telegram-center-v31/players/1/profile", "POST")).status, 405);
  assert.equal((await handleTelegramCenterV31(new Request("https://x.test/api/telegram-center-v31/players/1/profile"), {}, "/api/telegram-center-v31/players/1/profile")).status, 503);
  const res = await get(`/api/telegram-center-v31/players/1/profile?season=${season}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Cache-Control"), /max-age=300/);
  const body = await res.json();
  assert.equal(body.ok, true);
  const p = body.profile;
  assert.equal(p.pos_group, "F");
  assert.equal(p.peers_word, "нападающих");
  assert.deepEqual(p.ea, { game: "NHL 27", overall: 97, axes: SKATER_AXES.map((a, i) => ({ key: a.key, label: a.label, value: STAR_GROUPS[i] })) }, "the game's layer: the six groups");
  assert.equal(p.season.games, 7);
  assert.deepEqual(p.season.axes.map((a) => a.key), SKATER_AXES.map((a) => a.key), "the season under the same six axes");
  assert.ok(p.season.axes.every((a) => typeof a.pct === "number" && a.text && !/undefined|NaN/.test(a.text)));
  assert.equal(p.five.games, 280);
  assert.equal(p.five.peers, 104, "five seasons: the forwards of 82+ games only (the one of 80 is not a yardstick)");
  assert.equal(p.five.axes[0].text, "до 39,3 км/ч", "five seasons: the best speed, no bursts");
  assert.equal(p.min_games, MIN_GAMES);
  assert.ok(!JSON.stringify(p).includes('"raw"'), "only what the page shows");
  const small = (await (await get(`/api/telegram-center-v31/players/4/profile?season=${season}`)).json()).profile;
  assert.equal(small, null, "2 games, 80 in five seasons, not in the game: nothing to draw yet");
  const eight = (await (await get(`/api/telegram-center-v31/players/8/profile?season=${season}`)).json()).profile;
  assert.equal(eight.season.games, 5, "the 5th game: the season portrait appears");
  assert.equal(eight.ea, null);
  assert.deepEqual([eight.season.axes[0].pct, eight.season.axes[0].text], [null, "скорость ещё не измерена"], "last season's speed is not this season's");
  const gameOnly = (await (await get(`/api/telegram-center-v31/players/8477934/profile?season=${season}`)).json()).profile;
  assert.deepEqual([gameOnly.pos_group, gameOnly.ea.overall, gameOnly.season, gameOnly.season_games, gameOnly.five], ["F", 95, null, 0, null], "the game alone: its layer, the others wait");
  assert.deepEqual(gameOnly.ea.axes.map((a) => a.value), [88, 95, null, null, null, null]);
  const goalie = (await (await get(`/api/telegram-center-v31/players/31/profile?season=${season}`)).json()).profile;
  assert.deepEqual(goalie.ea.axes.map((a) => a.label), EA_GOALIE_AXES.map((a) => a.label), "a goalie: the goalie groups of the game");
  assert.deepEqual(goalie.season.axes.map((a) => a.label), GOALIE_AXES.map((a) => a.label), "and his own numbers");
  assert.equal(goalie.peers_word, "вратарей");
  const none = await (await get(`/api/telegram-center-v31/players/8400001/profile?season=${season}`)).json();
  assert.deepEqual(none, { ok: true, season, player_id: 8400001, profile: null });
  const old = await (await get("/api/telegram-center-v31/players/1/profile?season=20212022")).json();
  assert.equal(old.profile, null, "another season: nothing invented, and today's game rating is not shown for 2021");
  const bad = await (await get("/api/telegram-center-v31/players/1/profile?season=1;DROP")).json();
  assert.equal(bad.season, season, "a bad season falls back to the current one");
  const good2 = JSON.stringify(seasonAxes(2));
  raw.prepare("UPDATE player_season_profiles SET axes_json='{' WHERE player_id=2 AND season_id='20262027'").run();
  assert.equal((await get(`/api/telegram-center-v31/players/2/profile?season=${season}`)).status, 500);
  raw.prepare("UPDATE player_season_profiles SET axes_json=? WHERE player_id=2 AND season_id='20262027'").run(good2);

  const script = await (await get(SCRIPT_PATH)).text();
  assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
  assert.equal((await get(SCRIPT_PATH, "POST")).status, 405);
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v31-player.js?build=31.1"), "the script is in the app (a new build: the phones take the new portrait)");
  assert.ok(shell.indexOf("/telegram-app/v31-player.js") > shell.indexOf("/telegram-app/v30-nav.js"), "after the navigation layer");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), env, SCRIPT_PATH)).status, 200, "reachable through the main router");
  const entry = fs.readFileSync(new URL("../cloudflare-worker/src/worker-entry.js", import.meta.url), "utf8");
  assert.match(entry, /try \{\s*await runPlayerProfileMaintenance\(env\);\s*\} catch \(error\) \{/, "the cron runs it, a failure does not stop the rest");
  assert.ok(entry.indexOf("runPlayerProfileMaintenance(env)") > entry.indexOf("runFanPredictionDigest(env)"), "after the points of the fans: a slow NHL stats site does not delay them");
  const edgeFlow = fs.readFileSync(new URL("../.github/workflows/backfill-nhl-edge.yml", import.meta.url), "utf8");
  assert.match(edgeFlow, /schedule:\s*\n\s*- cron: "40 9 \* \* \*"/, "the EDGE speeds of the season are loaded every day");
  assert.match(edgeFlow, /--seasons "\$seasons"/, "the daily run loads the current season only");

  // ---- the card
  const html = `<!doctype html><html class="v15Light"><head></head><body><main id="view"><div class="v23PlayerProfile"><div class="v23Head">Кирилл Капризов</div><div id="v23Season">Статистика сезона</div><div class="v23Rest"></div></div></main></body></html>`;
  const dom = new JSDOM(html, { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  window.HOHV15 = { api: async (url) => { calls.push(url); const u = new URL(url, "https://x.test"); const r = await handleTelegramCenterV31(new Request(u), env, u.pathname, { now: NOW }); return r.json(); } };
  const open = async (id) => { window.HOHV23 = { current: { p: { player_id: id }, pack: { season } } }; doc.querySelector(".v23Rest").append(doc.createElement("i")); await tick(200); return doc.querySelector("[data-v31-portrait]"); };
  const pressed = (card) => Object.fromEntries([...card.querySelectorAll("[data-v31-layer]")].map((b) => [b.dataset.v31Layer, b.getAttribute("aria-pressed")]));
  const areas = (card) => [...card.querySelectorAll("svg.v31Radar polygon.area")].map((x) => x.dataset.layer);
  const press = async (k) => { doc.querySelector(`[data-v31-layer="${k}"]`).click(); await tick(10); return doc.querySelector("[data-v31-portrait]"); };
  window.HOHV23 = { current: { p: { player_id: 1 }, pack: { season } } };
  window.eval(script);
  await tick(150);
  let card = doc.querySelector("[data-v31-portrait]");
  assert.ok(card, "the portrait is on the page");
  assert.equal(card.previousElementSibling.id, "v23Season", "right after the season numbers");
  assert.deepEqual(calls, [`/api/telegram-center-v31/players/1/profile?season=${season}`]);
  assert.deepEqual(pressed(card), { ea: "true", season: "false", five: "false" }, "the game is the main layer; the season and the five seasons beside it, to press");
  assert.equal(card.querySelector('[data-v31-layer="ea"]').textContent, "NHL 27", "short: the three chips fit one line of a phone");
  assert.equal(card.querySelector(".v31PHead small").textContent, "NHL 27 · общий 97");
  const svg = card.querySelector("svg.v31Radar");
  assert.equal(svg.getAttribute("viewBox"), "-44 0 408 290");
  assert.equal(svg.querySelectorAll("polygon.ring").length, 4);
  assert.deepEqual(areas(card), ["ea"]);
  assert.equal(svg.querySelector("polygon.area").getAttribute("points").split(" ").length, 6, "a hexagon");
  assert.deepEqual([...svg.querySelectorAll("text.lab")].map((t) => [...t.querySelectorAll("tspan")].map((s) => s.textContent).join(" ")), ["Катание", "Атака", "Владение шайбой", "Оборона", "Физика", "Общие"]);
  assert.equal(svg.querySelectorAll("text.lab")[2].querySelectorAll("tspan").length, 2, "«Владение шайбой» in two lines: not cut on a phone");
  assert.equal(svg.querySelectorAll("text.pct")[1].textContent, "93", "the value of the game under the axis");
  assert.match(svg.getAttribute("aria-label"), /^Портрет игрока: Катание 92, Атака 93, Владение шайбой 92/);
  assert.deepEqual([...card.querySelectorAll(".v31Tbl thead th")].map((t) => t.textContent), ["Ось", "NHL 27"]);
  assert.equal(card.querySelectorAll(".v31Tbl tbody tr").length, 6);
  assert.match(card.textContent, /средняя оценка игры EA SPORTS по группе навыков, из 99; общий рейтинг 97/);
  assert.ok(doc.getElementById("v31css").textContent.includes(".v31Trend{"), "the bright tendencies are styled by this layer");
  assert.ok(doc.getElementById("v31css").textContent.includes(".v31RecOdds{"), "and the Winline card");

  // the season pressed: its shape over the game's, its numbers in the table
  card = await press("season");
  assert.deepEqual(pressed(card), { ea: "true", season: "true", five: "false" });
  assert.deepEqual(areas(card), ["ea", "season"]);
  assert.deepEqual([...card.querySelectorAll(".v31Tbl thead th")].map((t) => t.textContent), ["Ось", "NHL 27", "Сезон"]);
  assert.equal(card.querySelectorAll(".v31Tbl tbody tr")[1].querySelectorAll("td")[1].textContent, `${seasonAxes(1).offense}1,14 гола и 3,6 броска за матч`);
  assert.equal(svg.isConnected, false, "the card is drawn again in its place");
  assert.equal(card.previousElementSibling.id, "v23Season");
  assert.equal(doc.activeElement && doc.activeElement.dataset.v31Layer, "season", "the focus stays on the pressed layer");
  assert.match(card.textContent, /лучше скольких нападающих, в процентах \(в сезоне — от 5 матчей, за 5 сезонов — от 82\)/);
  card = await press("five");
  assert.deepEqual(areas(card), ["ea", "season", "five"]);
  card = await press("ea");
  card = await press("season");
  assert.deepEqual(areas(card), ["five"], "any layer can be turned off");
  card = await press("five");
  assert.deepEqual(areas(card), ["five"], "but the last one stays on");
  card = await press("ea");
  card = await press("five");
  assert.deepEqual(pressed(card), { ea: "true", season: "false", five: "false" });

  // the same player: nothing redrawn, nothing asked again
  window.HOHV31.update();
  assert.equal(doc.querySelector("[data-v31-portrait]"), card);
  assert.equal(calls.length, 1);

  // a player outside the game: his season is the main layer, the chip of the game says why it is off
  card = await open(2);
  assert.equal(doc.querySelectorAll("[data-v31-portrait]").length, 1, "one card, not two");
  assert.equal(card.dataset.key, `2:${season}`);
  assert.deepEqual(pressed(card), { ea: "false", season: "true", five: "false" });
  assert.equal(card.querySelector('[data-v31-layer="ea"]').disabled, true);
  assert.match(card.querySelector('[data-v31-layer="ea"]').textContent, /нет в игре/);
  assert.match(card.textContent, /EA показывает только 300 лучших игроков/);
  assert.equal(card.querySelector(".v31PHead small").textContent, "лучше скольких нападающих, %");
  card = await press("five");
  assert.deepEqual(areas(card), ["season", "five"]);
  card = await open(1);
  assert.deepEqual(pressed(card), { ea: "true", season: "true", five: "true" }, "the game stays on for the next player: pressing the five seasons there did not turn it off");
  card = await press("season");
  card = await press("five");

  // the game only (no games this season yet): the season waits for the 5th game, and the page says so
  card = await open(8477934);
  assert.deepEqual(pressed(card), { ea: "true", season: "false", five: "false" });
  assert.equal(card.querySelector('[data-v31-layer="season"]').disabled, true);
  assert.match(card.querySelector('[data-v31-layer="season"]').textContent, /с 5 матчей · сыграно 0/);
  assert.match(card.querySelector('[data-v31-layer="five"]').textContent, /от 82 матчей · сыграно 0/);
  assert.equal([...card.querySelectorAll("svg text.pct")].map((t) => t.textContent).join(" "), "88 95 — — — —", "a group the game does not rate: a dash");

  // a goalie: the hexagon of the game's goalie groups; his season numbers in a table of their own
  card = await open(31);
  assert.equal(card.querySelector("polygon.area").getAttribute("points").split(" ").length, 6);
  assert.deepEqual([...card.querySelectorAll("svg text.lab")].map((t) => t.textContent.replace(/\s+/g, "")), ["Верх", "Низ", "Позиция", "Добивания", "Выходыодиннаодин", "Катание"]);
  card = await press("season");
  assert.deepEqual(areas(card), ["ea"], "the goalie's numbers are other axes: not drawn over the game's");
  assert.equal(card.querySelectorAll(".v31Tbl").length, 2);
  assert.deepEqual([...card.querySelectorAll(".v31Tbl")[1].querySelectorAll("tbody th")].map((t) => t.textContent), GOALIE_AXES.map((a) => a.label));
  assert.match(card.textContent, /91,2% отражённых бросков/);
  card = await press("ea");
  assert.equal(card.querySelector("polygon.area").getAttribute("points").split(" ").length, 5, "the game off: his own pentagon");
  assert.deepEqual(areas(card), ["season"]);
  card = await press("ea");
  card = await press("season");

  // a goalie outside the game: his pentagon
  card = await open(33);
  assert.equal(card.querySelector("polygon.area").getAttribute("points").split(" ").length, 5);
  assert.deepEqual(areas(card), ["season"]);

  // a player without a portrait: no empty card
  card = await open(8400001);
  assert.equal(doc.querySelectorAll("[data-v31-portrait]").length, 0, "the card of the previous player is gone");
  card = await open(4);
  assert.equal(card, null, "too few games and not in the game: no card");

  // the full statistics page is not the profile: no portrait there
  await open(1);
  doc.querySelector(".v23PlayerProfile").classList.add("v23StatsPage");
  doc.querySelector("[data-v31-portrait]").remove();
  window.HOHV31.update();
  await tick(60);
  assert.equal(doc.querySelectorAll("[data-v31-portrait]").length, 0);
  window.close();

  // the labels are escaped; an axis without data shows a dash
  const d2 = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  d2.window.HOHV15 = { api: async () => ({}) };
  d2.window.eval(script);
  const out = d2.window.HOHV31.radarSvg([{ label: "<b>x</b>" }, { label: "a" }, { label: "b" }], [{ k: "ea", values: [50, null, 0] }]);
  assert.ok(!out.includes("<b>x</b>"));
  assert.match(out, />—<\/tspan>/);
  assert.equal(d2.window.HOHV31.cardHtml(null), "");
  assert.equal(d2.window.HOHV31.cardHtml({ ea: null, season: null, five: null }), "", "no layer: no card");
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
