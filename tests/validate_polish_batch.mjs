// The owner's review of 14 October: real times of the news (every news said "только что"), "24 года" and the positions in Russian
// everywhere, the player page without "Дата рождения:" and without the text pronunciation (the voice only, loaded in advance),
// the month of the calendar without "Г.", all the goals of the day behind the shelf, the clip index survives a slow server.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { extractNewsListPage, sportsDate, runSportsRuNewsMaintenance } from "../cloudflare-worker/src/telegram-center-v20-news.js";
import { loadClipIndex, handleTelegramCenterV27 } from "../cloudflare-worker/src/telegram-center-v27-home.js";
import { handleTelegramCenterV23PlayerUi } from "../cloudflare-worker/src/telegram-center-v23-player-ui.js";
import { handleTelegramCenterV19Ui } from "../cloudflare-worker/src/telegram-center-v19-ui.js";
import { handleTelegramCenterV15TeamUi } from "../cloudflare-worker/src/telegram-center-v15-team-ui.js";
import { handleTelegramCenterV15CoreUi } from "../cloudflare-worker/src/telegram-center-v15-core-ui.js";
import { handleTelegramCenterV8Ui } from "../cloudflare-worker/src/telegram-center-v8-ui.js";

const textOf = async (res) => (await res).text();
const lineOf = (source, start) => {
  const line = source.split("\n").find((l) => l.startsWith(start));
  assert.ok(line, `line starting with ${start}`);
  return line;
};

// ---- 1) the news: the real time from the Sports.ru list of NHL news --------------------------------------------------------------------
const LIST = `<div class="news"><div class="short-news"><b>14 октября </b>
<p class="one_news" data-news-dtime="2026-10-14 22:40:00+03" data-news-id="1117399865"><span class="time">22:40</span>
<a class="short-text" href="/hockey/1117399865.html" title="x">НХЛ. «Вашингтон» примет «Монреаль», «Колорадо» сыграет с «Далласом»</a><span class="sp">|</span><a href="/hockey/1117399865.html#comments">19</a></p>
<p class="one_news" data-news-dtime="2026-10-14 19:58:00+03" data-news-id="1117400972"><span class="time">19:58</span>
<a class="short-text" href="/hockey/1117400972-sergej-gomolyako.html">Сергей Гомоляко: «Канцеров – талантливый, суперработоспособный парень»</a></p>
<p class="one_news" data-news-dtime="2026-10-14 19:00:00+03"><a href="/hockey/1.html">Коротко</a></p></div></div>`;
{
  const items = extractNewsListPage(LIST, "https://www.sports.ru/hockey/tournament/nhl/news/");
  assert.deepEqual(items.map((x) => [x.source_url, x.published_at]), [
    ["https://www.sports.ru/hockey/1117399865.html", "2026-10-14T19:40:00.000Z"],
    ["https://www.sports.ru/hockey/1117400972-sergej-gomolyako.html", "2026-10-14T16:58:00.000Z"],
  ], "the time of every news, Moscow time turned into UTC; too short titles are not news");
  assert.equal(sportsDate("2026-10-14 22:40:00+03"), "2026-10-14T19:40:00.000Z");
  assert.equal(sportsDate("garbage"), null);
}
{
  const MIG = new URL("../migrations/", import.meta.url);
  const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
  const raw = new DatabaseSync(":memory:");
  raw.exec(migration("0001_hoh_data_core.sql").match(/CREATE TABLE IF NOT EXISTS teams \([\s\S]*?\n\);/)[0]);
  raw.exec(migration("0001_hoh_data_core.sql").match(/CREATE TABLE IF NOT EXISTS players \([\s\S]*?\n\);/)[0]);
  raw.exec(migration("0010_data_core_meta.sql").match(/CREATE TABLE IF NOT EXISTS data_core_meta \([\s\S]*?\n\);/)[0]);
  raw.exec(migration("0019_sports_news.sql"));
  raw.exec(migration("0040_sports_news_badges.sql"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
    run: async () => { raw.prepare(sql).run(...args); return {}; },
  });
  const db = { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
  // the main page knows the news without times; the list of news knows the times
  const MAIN = `<a href="/hockey/1117399865.html">НХЛ. «Вашингтон» примет «Монреаль», «Колорадо» сыграет с «Далласом»</a><a href="/hockey/1117390000.html">Старая новость про НХЛ, которой уже нет в списке новостей</a>`;
  let listUp = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://www.sports.ru/hockey/tournament/nhl/news/")) return listUp ? new Response(LIST, { status: 200 }) : new Response("down", { status: 503 });
    if (u.startsWith("https://www.sports.ru/hockey/tournament/nhl/")) return new Response(MAIN, { status: 200 });
    return new Response("", { status: 404 });
  };
  const timeOf = (id) => raw.prepare("SELECT published_at FROM sports_news WHERE source_url LIKE ?").get(`%${id}%`)?.published_at;
  await runSportsRuNewsMaintenance({ DB: db }, { force: true });
  assert.equal(timeOf("1117399865"), "2026-10-14T19:40:00.000Z", "the news has its real time, not the time of our scan");
  assert.equal(timeOf("1117400972-sergej"), "2026-10-14T16:58:00.000Z", "news only in the list are stored too");
  const guessed = timeOf("1117390000");
  assert.ok(guessed, "a news without a known time gets the time of the scan once");
  listUp = false;
  await new Promise((r) => setTimeout(r, 20));
  await runSportsRuNewsMaintenance({ DB: db }, { force: true });
  assert.equal(timeOf("1117399865"), "2026-10-14T19:40:00.000Z", "a later scan without the list does not overwrite a known time with the time of the scan");
  assert.equal(timeOf("1117390000"), guessed, "nor the first guess (before: every scan moved it to 'just now')");
  globalThis.fetch = realFetch;
}

// ---- 2) "24 года" and the positions in Russian ------------------------------------------------------------------------------------------
{
  const v23 = await textOf(handleTelegramCenterV23PlayerUi(new Request("https://x.test/telegram-app/v23-player.js"), "/telegram-app/v23-player.js"));
  const team = await textOf(handleTelegramCenterV15TeamUi(new Request("https://x.test/telegram-app/v15-team.js"), "/telegram-app/v15-team.js"));
  const core = await textOf(handleTelegramCenterV15CoreUi(new Request("https://x.test/telegram-app/v15-core.js"), "/telegram-app/v15-core.js"));
  const v8 = await textOf(handleTelegramCenterV8Ui(new Request("https://x.test/telegram-app"), "/telegram-app"));
  for (const [name, src] of [["player page", v23], ["team page", team], ["core", core], ["players tab", v8]]) {
    assert.ok(!/\+' лет'/.test(src), `${name}: no "24 лет"`);
    assert.ok(/yearsRu\(/.test(src), `${name}: the age is declined`);
  }
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(`${lineOf(v23, "function posRu(c)")}\n${lineOf(v23, "function yearsRu(n)")}\nwindow.posRu=posRu;window.yearsRu=yearsRu;`);
  assert.deepEqual(["C", "L", "R", "D", "G", "x", ""].map((c) => dom.window.posRu(c)), ["ЦН", "ЛН", "ПН", "З", "В", "x", "—"]);
  assert.deepEqual([21, 24, 25, 31, 33, 19, 11].map((n) => `${n} ${dom.window.yearsRu(n)}`), ["21 год", "24 года", "25 лет", "31 год", "33 года", "19 лет", "11 лет"]);
  assert.match(team, /H\.esc\(posRu\(p\.position_code\)\)\+\(p\.age\?' · '\+p\.age\+' '\+yearsRu\(p\.age\):''\)/, "the roster: «З · 24 года»");
  assert.match(v8, /esc\(posRu\(p\.position_code\)\)/, "the players tab: «MIN · ЛН · #97»");

  // ---- 3) the head of the player page
  const header = lineOf(v23, "function header(ctx)");
  assert.ok(!/Произношение:/.test(header), "no text pronunciation, the voice only");
  assert.ok(!/Дата рождения/.test(header), "the date speaks for itself");
  assert.match(header, /esc\(posRu\(p\.position_code\)\)/);
  assert.match(v23, /const clip=new Audio\(ctx\.audio\.audio_url\);clip\.preload='auto';/, "the voice is loaded when the page opens, the button plays at once");

  // the player page listens to every click on the window and opens the player of a row: the "+" of the row must win
  const start = v23.indexOf("function capturePlayerClick(e){");
  const fn = v23.slice(start, v23.indexOf("\n}\n", start) + 3);
  const page = new JSDOM(`<div class="playerRow" data-player="8478864"><b>Капризов</b><button class="v28Fol">+</button></div>`, { runScripts: "outside-only" });
  page.window.eval(`var opened=[];function openPlayer(id){opened.push(id)}\n${fn}\nwindow.capturePlayerClick=capturePlayerClick;window.opened=opened;`);
  const click = (el) => { const e = new page.window.MouseEvent("click", { bubbles: true, cancelable: true }); Object.defineProperty(e, "target", { value: el }); page.window.capturePlayerClick(e); return e; };
  const plus = click(page.window.document.querySelector(".v28Fol"));
  assert.deepEqual([...page.window.opened], [], "a tap on «+» does not open the player");
  assert.equal(plus.defaultPrevented, false, "and is left for the button");
  click(page.window.document.querySelector("b"));
  assert.deepEqual([...page.window.opened], [8478864], "a tap on the row still opens him");
}

// ---- 4) the month of the calendar ------------------------------------------------------------------------------------------------------------
{
  const v19 = await textOf(handleTelegramCenterV19Ui(new Request("https://x.test/telegram-app/v19.js"), "/telegram-app/v19.js"));
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(`${lineOf(v19, "function monthLabel(v)")}\nwindow.monthLabel=monthLabel;`);
  assert.equal(dom.window.monthLabel("2026-10-14"), "Октябрь 2026", "not «Октябрь 2026 Г.»");
  assert.equal(dom.window.monthLabel("2027-01-01"), "Январь 2027");
}

// ---- 5) all the goals of the day: the shelf, its last tile, the page --------------------------------------------------------------------------
{
  const ui = await textOf(handleTelegramCenterV27(new Request("https://x.test/telegram-app/v27-home.js"), {}, "/telegram-app/v27-home.js"));
  assert.match(ui, /const SHELF_TILES = 16;/);
  assert.match(ui, /gl\.items\.slice\(0, SHELF_TILES\)/, "the shelf shows 16 goals");
  assert.match(ui, /data-v27-goals-all="1"><span class="v27Poster"><b>\$\{esc\(gl\.items\.length\)\}<\/b><span>все голы<\/span>/, "its last tile counts all of them and opens the page");
  assert.match(ui, /if \(t\.closest\("\[data-v27-goals-all\]"\)\) return openGoalsPage\(\);/);
  assert.match(ui, /data-v27-gfilter="ru"/, "the page can show the Russians only");
}

// ---- 6) the clip index survives a slow server ------------------------------------------------------------------------------------------------
{
  const good = async () => ({ games: [{ game_pk: 1, goals: [] }] });
  const slow = async () => { throw new Error("timeout"); };
  const BASE = "https://clips.test";
  assert.equal((await loadClipIndex(BASE, { fetcher: good, now: 1_000 })).games.length, 1);
  assert.equal((await loadClipIndex(BASE, { fetcher: slow, now: 1_000 + 10 * 60_000 })).games.length, 1, "a slow server: the last good index, the goals stay on the home page");
  await assert.rejects(loadClipIndex(BASE, { fetcher: slow, now: 1_000 + 31 * 60_000 }), /timeout/, "but not one older than half an hour");
  await assert.rejects(loadClipIndex("https://other.test", { fetcher: slow, now: 5_000 }), /timeout/, "nothing kept: an honest failure");
  let asked = null;
  await loadClipIndex(BASE, { fetcher: async (url, opts) => { asked = { url, ...opts }; return { games: [] }; }, now: 2_000 });
  assert.deepEqual(asked, { url: "https://clips.test/index.json", ttl: 20, timeoutMs: 8000 }, "it waits up to 8 seconds now (4 before)");
}

// ---- 7) «Вчера · 16 матчей | Сегодня · 2 матча» on top of the home page ----------------------------------------------------------------------
{
  const { dayButtons } = await import("../cloudflare-worker/src/telegram-center-v27-home-data.js");
  const { loadDayPayload } = await import("../cloudflare-worker/src/telegram-center-v27-home.js");
  const g = (pk, date, phase = "final") => ({ game_pk: pk, date, phase, start: `${date}T23:00:00Z`, start_ms: Date.parse(`${date}T23:00:00Z`), away: { tri: "NJD" }, home: { tri: "DET" }, away_score: 5, home_score: 4 });
  const games = [g(1, "2026-10-13"), g(2, "2026-10-13"), g(3, "2026-10-13"), g(4, "2026-10-14", "upcoming"), g(5, "2026-10-14", "upcoming"), { ...g(6, "2026-10-12"), phase: "postponed" }, g(7, "2026-10-12")];
  assert.deepEqual(dayButtons(games, "2026-10-14"), { main: { date: "2026-10-14", count: 2 }, other: { date: "2026-10-13", count: 3 } }, "the day of the page and the last day before it, with their games");
  assert.deepEqual(dayButtons(games, "2026-10-12").other, null, "nothing before: one button would make no sense");
  assert.equal(dayButtons(games, null), null);
  assert.equal(dayButtons(games, "2026-10-13").other.count, 1, "a postponed game does not count");
  const deps = { loadGames: async () => games, loadRussians: async (env, strip) => strip.map((x) => ({ player_id: x.game_pk, name_ru: "Капризов", line: { kind: "s", goals: 2, assists: 0 } })) };
  const day = await loadDayPayload({}, { date: "2026-10-13", deps });
  assert.equal(day.ok, true);
  assert.deepEqual(day.games.map((x) => x.game_pk), [1, 2, 3], "the strip of that day");
  assert.equal(day.russians.items.length, 3, "and its Russians with their numbers");
  assert.equal((await loadDayPayload({}, { date: "yesterday", deps })).error, "invalid_date");
  const failing = await loadDayPayload({}, { date: "2026-10-13", deps: { ...deps, loadRussians: async () => { throw new Error("nhl down"); } } });
  assert.deepEqual([failing.ok, failing.russians.ok, failing.games.length], [true, false, 3], "the NHL box scores down: the results still come");
  const ui = await textOf(handleTelegramCenterV27(new Request("https://x.test/telegram-app/v27-home.js"), {}, "/telegram-app/v27-home.js"));
  assert.match(ui, /const SECTIONS = \["days", "strip"/, "the switch is the first thing of the home page");
  assert.match(ui, /data-v27-day="\$\{key\}"/);
  assert.match(ui, /if \(d\.otherDay\) return `Русские \$\{relDay\(d\.russians\.day, d\.today \|\| localToday\(\)\)\.toLowerCase\(\)\}`;/, "«Русские вчера»");
  assert.match(ui, /await H\.api\(`\$\{API\}\/day\?date=\$\{encodeURIComponent\(date\)\}`\)/, "the other day is loaded only on a tap");
}

console.log("polish batch validation passed");
