// v30: the navigation fixes of the owner's review — the tabs and the back row stay on top, back returns to the same card, the
// calendar is one week (the month on a tap), the long «Кто победит?» explanation folds after the first time, a finished score is
// big with the winner bold, the names in the players list are not cut.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { handleTelegramCenterV30, SCRIPT_PATH } from "../cloudflare-worker/src/telegram-center-v30-nav.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const script = await (await handleTelegramCenterV30(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).text();
assert.equal(await handleTelegramCenterV30(new Request("https://x.test/other"), {}, "/other"), null);
assert.equal((await handleTelegramCenterV30(new Request(`https://x.test${SCRIPT_PATH}`, { method: "POST" }), {}, SCRIPT_PATH)).status, 405);
assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
{
  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v30-nav.js?build=30.1"), "the script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v30-nav.js") > shell.indexOf("/telegram-app/v29-predict.js"), "after the vote layer");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).status, 200, "reachable through the main router");
}

const days = (sel) => Array.from({ length: 31 }, (_, i) => {
  const d = `2026-10-${String(i + 1).padStart(2, "0")}`;
  return `<button class="v19Day has${d === sel ? " sel" : ""}${d === "2026-10-14" ? " today" : ""}" data-v19-date="${d}">${i + 1}</button>`;
}).join("");
// since 2026-10-19 the names are once, with the score (or the time of a game ahead) between them: under the cover, or under the logos
const card = (pk, title, score, live = false) => {
  const [away, home] = title.split(" — ");
  const mid = score === "—" ? '<b class="v19CardMid"><i class="v19CardTime">02:30</i></b>' : `<b class="v19CardMid"><i class="v19CardScore">${score}</i></b>`;
  const top = live ? '<div class="top"><span class="v19LiveBadge">LIVE</span></div>' : "";
  if (pk % 2) return `<article class="v19Broadcast" data-v19-game="${pk}"><div class="v19Thumb"><img src="/c.jpg" alt=""></div><div class="v19BroadcastText">${top}<div class="v19Board"><span data-v19-side="away">${away}</span>${mid}<span data-v19-side="home">${home}</span></div></div></article>`;
  const logo = (k, name) => `<div data-v19-side="${k}"><img src="/l.svg" alt=""><span>${name}</span></div>`;
  return `<article class="v19Broadcast" data-v19-game="${pk}"><div class="v19Thumb"><div class="v19ThumbTeams">${logo("away", away)}${mid}${logo("home", home)}</div></div><div class="v19BroadcastText">${top}</div></article>`;
};
function makeApp({ storage = {}, sel = "2026-10-13" } = {}) {
  const html = `<!doctype html><html class="v15Light"><head></head><body><div class="app"><div class="v22NavRow"><nav id="tabs"></nav></div>
<main id="view"><div class="v19Archive"><section class="v19Cal"><div class="v19CalTop"><b>Октябрь 2026</b></div><div class="v19Days">${days(sel)}</div></section>
<div id="v29MatchesHead" class="v29MatchesHead"><div class="v29MhTop"><b>Кто победит?</b></div><div class="v29Note">Голосуйте прямо в карточках матчей…</div></div>
<div class="v19BroadcastList">${card(1, "Нью-Джерси Девилз — Детройт Ред Уингз", "5 : 4 ОТ")}${card(2, "Флорида Пантерз — Коламбус Блю Джекетс", "3 : 7")}${card(3, "Бостон Брюинз — Сан-Хосе Шаркс", "2 : 1", true)}${card(4, "Монреаль Канадиенс — Вашингтон Кэпиталс", "—")}</div></div>
<div class="playerRow" data-player="8478864"><div class="rowText"><b>Кирилл Капризов</b></div></div></main></div></body></html>`;
  const dom = new JSDOM(html, { url: "https://x.test/telegram-app-v24", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const scrolls = [];
  window.scrollTo = (x, y) => { scrolls.push(y); };
  window.HOHV15 = { state: { profile: false }, currentTab: () => "broadcasts" };
  window.eval(script);
  return { dom, window, document: window.document, scrolls };
}

// ---- 1) the bars on top and the names that are not cut -------------------------------------------------------------------------------------
{
  const { window, document } = makeApp();
  await tick(120);
  const css = document.getElementById("v30css").textContent;
  assert.match(css, /\.v22NavRow,\.v22BackRow,:not\(\.v22BackRow\)>\.v15BackRow\{position:sticky!important;top:0;z-index:40;/, "the tabs and the back row (with the eye and the gear) stay on top");
  assert.match(css, /html body \.app,html body #view\{overflow-x:clip!important;overflow-y:visible!important\}/, "the containers no longer break sticky (overflow hidden made them scroll boxes)");
  assert.match(css, /html,body\{overflow-x:clip!important;overflow-y:visible!important\}/);
  assert.match(css, /\.playerRow \.rowText b\{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;/, "the names are not cut");
  assert.ok(window.HOHV30 && typeof window.HOHV30.update === "function");
  window.close();
}

// ---- 2) the calendar: a week around the chosen day, the month on a tap ------------------------------------------------------------------------
{
  const { window, document } = makeApp({ sel: "2026-10-13" });
  await tick(120);
  const cal = document.querySelector(".v19Cal");
  const visible = () => [...document.querySelectorAll(".v19Day")].filter((d) => !(cal.classList.contains("v30Week") && d.classList.contains("v30Out"))).map((d) => Number(d.textContent));
  assert.ok(cal.classList.contains("v30Week"), "a week by default");
  assert.deepEqual(visible(), [10, 11, 12, 13, 14, 15, 16], "three days on each side of the chosen one");
  const more = cal.querySelector(".v30CalMore");
  assert.equal(more.textContent, "Весь месяц ▾");
  more.click();
  await tick(10);
  assert.ok(!cal.classList.contains("v30Week"), "the whole month on a tap");
  assert.equal(visible().length, 31);
  assert.equal(more.textContent, "Свернуть до недели ▴");
  assert.equal(window.localStorage.getItem("hoh-cal-month"), "1", "the choice is remembered");
  more.click();
  await tick(10);
  assert.ok(cal.classList.contains("v30Week"));
  window.close();
  const edge = makeApp({ sel: "2026-10-02" });
  await tick(120);
  const cal2 = edge.document.querySelector(".v19Cal");
  assert.deepEqual([...edge.document.querySelectorAll(".v19Day")].filter((d) => !d.classList.contains("v30Out")).map((d) => Number(d.textContent)), [1, 2, 3, 4, 5, 6, 7], "at the start of the month the week starts with the 1st");
  assert.ok(cal2.classList.contains("v30Week"));
  edge.window.close();
  const opened = makeApp({ storage: { "hoh-cal-month": "1" } });
  await tick(120);
  assert.ok(!opened.document.querySelector(".v19Cal").classList.contains("v30Week"), "a person who opened the month keeps it open");
  opened.window.close();
}

// ---- 3) the head of «Кто победит?» is one fact about the fan now (2026-10-19): nothing to fold, no «Как это работает?» ---------------------
{
  const app = makeApp({ storage: { "hoh-v29-explained": "1" } });
  await tick(120);
  const head = app.document.getElementById("v29MatchesHead");
  assert.ok(!head.classList.contains("v30Short") && !head.querySelector(".v30Why"), "the head is left as v29 draws it");
  assert.ok(!/v30Short|v30Why/.test(app.document.getElementById("v30css").textContent));
  app.window.close();
}

// ---- 4) the winner of a finished game is bold -------------------------------------------------------------------------------------------
{
  const { window, document } = makeApp();
  await tick(120);
  const side = (pk, k) => document.querySelector(`.v19Broadcast[data-v19-game="${pk}"] [data-v19-side="${k}"]`);
  const score = (pk) => document.querySelector(`.v19Broadcast[data-v19-game="${pk}"] .v19CardScore`);
  assert.ok(side(1, "away").classList.contains("v30Win") && side(1, "home").classList.contains("v30Lose"), "5:4 under the cover: the guests won");
  assert.equal(side(1, "away").textContent, "Нью-Джерси Девилз", "the text is the same");
  assert.ok(side(2, "home").classList.contains("v30Win") && side(2, "away").classList.contains("v30Lose"), "3:7 under the logos: the hosts won");
  assert.equal(side(2, "home").querySelector("span").textContent, "Коламбус Блю Джекетс");
  assert.ok(!side(3, "away").classList.contains("v30Win") && !side(3, "home").classList.contains("v30Win") && !side(3, "home").classList.contains("v30Lose"), "a game that is on has no winner yet");
  assert.ok(!document.querySelector('.v19Broadcast[data-v19-game="4"] .v30Win') && !document.querySelector('.v19Broadcast[data-v19-game="4"] .v30Lose'), "a game ahead neither");
  assert.ok(!score(4), "a game ahead has its time, not a score");
  const css = document.getElementById("v30css").textContent;
  assert.ok(!/v30Has/.test(css), "the old small score line is gone");
  assert.match(css, /\.hohNoSpoilers \.v30Win,\.hohNoSpoilers \.v30Lose\{font-weight:inherit;opacity:1\}/, "the no-spoilers mode shows no winner");
  // the list is drawn again with a new score: the names follow
  score(1).textContent = "5 : 6 Б";
  window.HOHV30.update();
  assert.ok(side(1, "home").classList.contains("v30Win") && side(1, "away").classList.contains("v30Lose"));
  // a draw on the board (a shootout still to come) marks nobody
  score(1).textContent = "2 : 2";
  window.HOHV30.update();
  assert.ok(!document.querySelector('.v19Broadcast[data-v19-game="1"] .v30Win') && !document.querySelector('.v19Broadcast[data-v19-game="1"] .v30Lose'));
  window.close();
}

// ---- 5) back to the same card --------------------------------------------------------------------------------------------------------------------
{
  const { window, document, scrolls } = makeApp();
  await tick(120);
  const cardEl = document.querySelector('.v19Broadcast[data-v19-game="2"]');
  cardEl.getBoundingClientRect = () => ({ top: 373, left: 12, width: 366, height: 200 });
  cardEl.querySelector(".v19Thumb").click();
  assert.deepEqual(window.HOHV30.anchor().selector, '.v19Broadcast[data-v19-game="2"]', "a tap on a card remembers it");
  // the match opens (inner page), then back: the list is drawn again from the top
  window.HOHV15.state.profile = true;
  window.HOHV30.update();
  assert.deepEqual(scrolls, [], "nothing moves while the match is open");
  window.HOHV15.state.profile = false;
  const list = document.querySelector(".v19BroadcastList");
  list.innerHTML = list.innerHTML; // a fresh list
  const fresh = document.querySelector('.v19Broadcast[data-v19-game="2"]');
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  fresh.getBoundingClientRect = () => ({ top: 1600, left: 12, width: 366, height: 200 });
  window.HOHV30.update();
  assert.deepEqual(scrolls, [1600 - 373], "the page scrolls so the card is where it was");
  assert.equal(window.HOHV30.anchor(), null, "once");
  // a tap on the vote or on «+» is not "open the card"
  const vote = document.createElement("button");
  vote.dataset.v29Pick = "home";
  fresh.appendChild(vote);
  vote.click();
  assert.equal(window.HOHV30.anchor(), null);
  window.close();
}

console.log("nav v30 validation passed");
