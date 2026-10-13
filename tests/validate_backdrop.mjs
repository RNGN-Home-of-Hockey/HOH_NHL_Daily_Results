// The backdrop of the app (v28): a light silhouette of a real player behind the cards, different from screen to screen and from day
// to day, switchable in the settings; and the players tab: a big number on the right and a small follow button next to it.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { handleTelegramCenterV28, SILHOUETTES, SCRIPT_PATH } from "../cloudflare-worker/src/telegram-center-v28-backdrop.js";
import { handleTeamCurrentRequest } from "../cloudflare-worker/src/team-current-routes.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BG_DIR = new URL("../cloudflare-worker/public/telegram-app/bg/", import.meta.url);

// ---- 1) the pictures: one light WebP with transparency per name, nothing else in the folder ---------------------------------------
{
  const files = fs.readdirSync(BG_DIR).sort();
  assert.deepEqual(files, SILHOUETTES.map((k) => `${k}.webp`).sort(), "a file for every name and no stray files");
  let total = 0;
  for (const name of files) {
    const b = fs.readFileSync(new URL(name, BG_DIR));
    total += b.length;
    assert.equal(b.toString("ascii", 0, 4), "RIFF", `${name}: a RIFF file`);
    assert.equal(b.toString("ascii", 8, 12), "WEBP", `${name}: a WebP`);
    assert.equal(b.toString("ascii", 12, 16), "VP8X", `${name}: the extended WebP that can carry transparency`);
    assert.ok(b[20] & 0x10, `${name}: with an alpha channel (a silhouette, not a photo with a background)`);
    const w = b.readUIntLE(24, 3) + 1;
    const h = b.readUIntLE(27, 3) + 1;
    assert.ok(w >= 400 && w <= 1000 && h >= 400 && h <= 1000, `${name}: a sensible size (${w}x${h})`);
    assert.ok(b.length < 80 * 1024, `${name}: light (${b.length} bytes)`);
  }
  assert.ok(total < 700 * 1024, `all of them together stay light (${total} bytes)`);
}

// ---- 2) the routes -----------------------------------------------------------------------------------------------------------------
const script = await (await handleTelegramCenterV28(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).text();
{
  const res = await handleTelegramCenterV28(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(script, /^\(function\(\)\{const __name=/, "wrapped like the other layers");
  assert.equal((await handleTelegramCenterV28(new Request(`https://x.test${SCRIPT_PATH}`, { method: "POST" }), {}, SCRIPT_PATH)).status, 405);
  assert.equal(await handleTelegramCenterV28(new Request("https://x.test/telegram-app/other.js"), {}, "/telegram-app/other.js"), null, "other paths are not taken");

  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response("img", { status: 200, headers: { "content-type": "application/octet-stream" } }); } } };
  const ok = await handleTelegramCenterV28(new Request("https://x.test/telegram-app/bg/kaprizov.webp?v=1"), env, "/telegram-app/bg/kaprizov.webp");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/webp");
  assert.match(ok.headers.get("cache-control"), /max-age=604800/, "cached for a week");
  assert.deepEqual(seen, ["/telegram-app/bg/kaprizov.webp"]);
  assert.equal((await handleTelegramCenterV28(new Request("https://x.test/telegram-app/bg/nobody.webp"), env, "/telegram-app/bg/nobody.webp")).status, 404, "only the known names");
  assert.equal((await handleTelegramCenterV28(new Request("https://x.test/telegram-app/bg/kaprizov.webp", { method: "PUT" }), env, "/telegram-app/bg/kaprizov.webp")).status, 405);
  assert.equal((await handleTelegramCenterV28(new Request("https://x.test/telegram-app/bg/kaprizov.webp"), {}, "/telegram-app/bg/kaprizov.webp")).status, 503, "no assets binding: said plainly");
  const missing = { ASSETS: { fetch: async () => new Response("nope", { status: 404 }) } };
  assert.equal((await handleTelegramCenterV28(new Request("https://x.test/telegram-app/bg/ovechkin.webp"), missing, "/telegram-app/bg/ovechkin.webp")).status, 404);

  const shell = await (await handleTeamCurrentRequest(new Request("https://x.test/telegram-app-v24"), {}, "/telegram-app-v24")).text();
  assert.ok(shell.includes("/telegram-app/v28-backdrop.js"), "the backdrop script is in the app");
  assert.ok(shell.indexOf("/telegram-app/v28-backdrop.js") > shell.indexOf("/telegram-app/v27-home.js"), "after the home page");
  assert.equal((await handleTeamCurrentRequest(new Request(`https://x.test${SCRIPT_PATH}`), {}, SCRIPT_PATH)).status, 200, "reachable through the main router");
  const routedBg = await handleTeamCurrentRequest(new Request("https://x.test/telegram-app/bg/crosby.webp"), env, "/telegram-app/bg/crosby.webp");
  assert.equal(routedBg.status, 200, "the pictures too");
  assert.equal(routedBg.headers.get("content-type"), "image/webp");
}

// ---- the page harness --------------------------------------------------------------------------------------------------------------
const DAY = 20374 * 86400000 + 3600000; // a fixed day, so the rotation is the same on every run
const logo = (tri) => `https://assets.nhle.com/logos/nhl/svg/${tri}_light.svg`;
const playersHtml = (rows) => `<div class="list">${rows.map(([id, name, value]) => `<div class="playerRow" data-player="${id}"><img src="x.png"><div><b>${name}</b><small>MIN</small></div><span class="playerSortValue">${value}</span><span>›</span></div>`).join("")}</div>`;

function makeApp({ tab = "games", html = "", stored = {}, follows = [], followsFail = false, light = true, now = DAY } = {}) {
  const dom = new JSDOM(`<!doctype html><html${light ? ' class="v15Light"' : ""}><head></head><body><nav id="tabs"><button class="tab active" data-tab="games"></button><button class="tab" data-tab="players"></button></nav><main id="view">${html}</main></body></html>`, { url: "https://x.test/telegram-app-v24", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  const box = { follows: follows.map((x) => ({ ...x })), followsFail, nextId: 500, tab };
  const calls = [];
  const alerts = [];
  const changes = [];
  const loads = [];
  window.Date.now = () => now;
  window.alert = (m) => alerts.push(m);
  // no network in the test: every picture "loads" at once
  window.Image = class {
    set src(v) { this._src = v; loads.push(v); setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return this._src; }
  };
  window.addEventListener("hoh-follows-change", () => changes.push(1));
  window.HOHV15 = {
    esc,
    V2: "/v2",
    state: { profile: false },
    currentTab: () => box.tab,
    tabsVisible: () => true,
    view: () => window.document.getElementById("view"),
    runCore: () => {},
    api: async (url, opt = {}) => {
      calls.push({ url, method: opt.method || "GET", body: opt.body ? JSON.parse(opt.body) : null });
      if (url === "/v2/subscriptions" && !opt.method) {
        if (box.followsFail) throw new Error("HTTP 401");
        return { ok: true, subscriptions: box.follows };
      }
      if (url === "/v2/subscriptions" && opt.method === "POST") {
        const row = { subscription_id: box.nextId++, subject_type: "player", subject_key: JSON.parse(opt.body).key };
        box.follows.push(row);
        return { ok: true, subscription: row };
      }
      const m = /^\/v2\/subscriptions\/(\d+)$/.exec(url);
      if (m && opt.method === "DELETE") {
        box.follows = box.follows.filter((s) => s.subscription_id !== Number(m[1]));
        return { ok: true };
      }
      return { ok: true };
    },
  };
  window.eval(script);
  return { window, document: window.document, box, calls, alerts, changes, loads, S: window.HOHV28 };
}
const layerOf = (ctx) => ctx.document.getElementById("hohSil");

// ---- 3) which silhouette goes where --------------------------------------------------------------------------------------------------
{
  const ctx = makeApp();
  const { S } = ctx;
  assert.deepEqual(JSON.parse(JSON.stringify(S.pool.map((p) => p.k))), SILHOUETTES, "the pool of the page is exactly the pictures on the server");
  assert.equal(new Set(S.pool.map((p) => p.id)).size, S.pool.length, "one player per picture");

  // screens
  const view = ctx.document.getElementById("view");
  assert.deepEqual(JSON.parse(JSON.stringify(S.screen())), { key: "games" }, "a tab of the app");
  view.innerHTML = `<div id="v26Root"><img src="${logo("PIT")}"><img src="${logo("WSH")}"></div>`;
  assert.deepEqual(JSON.parse(JSON.stringify(S.screen())), { key: "match:PIT-WSH", tris: ["PIT", "WSH"] }, "a match: both teams");
  view.innerHTML = '<section class="v23PlayerProfile"><img src="https://assets.nhle.com/mugs/nhl/20252026/WSH/8471214.png"></section>';
  assert.deepEqual(JSON.parse(JSON.stringify(S.screen())), { key: "player:8471214", id: 8471214, tris: ["WSH"] }, "a player: his id and team");
  view.innerHTML = '<section class="v27NewsPage"></section>';
  assert.equal(S.screen().key, "news");
  view.innerHTML = `<section class="v15Profile"><img src="${logo("TBL")}"></section>`;
  assert.deepEqual(JSON.parse(JSON.stringify(S.screen())), { key: "team:TBL", tris: ["TBL"] }, "a team page");
  view.innerHTML = "";
  ctx.window.HOHV15.state.profile = true;
  assert.equal(S.screen().key, "page");
  ctx.window.HOHV15.state.profile = false;

  // the choice
  assert.equal(S.choose({ key: "player:8471214", id: 8471214, tris: ["WSH"] }).k, "ovechkin", "a player of the pool gets his own silhouette");
  assert.equal(S.choose({ key: "player:8478864", id: 8478864, tris: ["MIN"] }).k, "kaprizov");
  assert.equal(S.choose({ key: "player:1", id: 1, tris: ["MIN"] }).k, "kaprizov", "another player: a team mate from the pool");
  assert.equal(S.choose({ key: "team:TBL", tris: ["TBL"] }).k, "kucherov", "a team page: a player of the team");
  assert.ok(["malkin", "crosby"].includes(S.choose({ key: "match:PIT-WSH", tris: ["PIT", "WSH"] }).k), "a match: a player of the first team that has one");
  assert.equal(S.choose({ key: "match:BOS-WSH", tris: ["BOS", "WSH"] }).k, "ovechkin", "or of the second one");
  const tabs = ["games", "broadcasts", "teams", "players", "follows", "news", "standings", "page"];
  const picks = tabs.map((key) => S.choose({ key }).k);
  assert.ok(new Set(picks).size >= 4, `the screens get different players (${picks.join(", ")})`);
  assert.equal(S.choose({ key: "games" }).k, S.choose({ key: "games" }).k, "the same screen keeps its player during the day");
  ctx.window.close();

  // the next day: other players on the same screens, the team mates take turns
  const next = makeApp({ now: DAY + 86400000 });
  const nextPicks = tabs.map((key) => next.S.choose({ key }).k);
  assert.ok(tabs.every((_, i) => picks[i] !== nextPicks[i]), "every screen changes its player the next day");
  const pit = (c) => c.S.choose({ key: "team:PIT", tris: ["PIT"] }).k;
  const first = makeApp();
  assert.notEqual(pit(first), pit(next), "Malkin and Crosby take turns on the Penguins page");
  assert.equal(next.S.choose({ key: "player:8471214", id: 8471214, tris: ["WSH"] }).k, "ovechkin", "but a player keeps his own silhouette");
  first.window.close();
  next.window.close();
}

// ---- 4) the layer on the page: on by default, crossfades between screens, can be switched off ---------------------------------------
{
  const ctx = makeApp();
  await tick(60);
  const html = ctx.document.documentElement;
  const layer = layerOf(ctx);
  assert.ok(html.classList.contains("hohSil"), "on by default");
  assert.ok(layer, "the layer is on the page");
  assert.equal(layer.getAttribute("aria-hidden"), "true", "screen readers skip it");
  assert.ok(layer.classList.contains("on"));
  const k = ctx.S.choose({ key: "games" }).k;
  assert.equal(layer.dataset.sil, k);
  assert.ok(["left", "right"].includes(layer.dataset.side));
  assert.equal(layer.style.getPropertyValue("--sil-img"), `url("/telegram-app/bg/${k}.webp?v=1")`, "a picture of our own server");
  const css = ctx.document.getElementById("v28css").textContent;
  assert.match(css, /#hohSil\{position:fixed;z-index:0;[^}]*pointer-events:none;opacity:0;transition:opacity \.6s/, "fixed, behind, never in the way of a tap, fades in");
  assert.match(css, /mask-image:var\(--sil-img\)/, "a flat shape: the picture is a mask, not a photo");
  assert.match(css, /#hohSil\.on\{opacity:var\(--sil-op\)\}/);
  const op = Number(/html\{--sil-a:[^;]+;--sil-b:[^;]+;--sil-op:([\d.]+)\}/.exec(css)[1]);
  assert.ok(op > 0.08 && op <= 0.25, `light, not a photo (${op})`);
  assert.match(css, /html:not\(\.v15Light\)\{--sil-a:[^;]+;--sil-b:[^;]+;--sil-op:[\d.]+\}/, "its own colours in the dark theme");
  assert.match(css, /html\.hohSil body:before\{background-image:linear-gradient\([^)]*\)[^;]*!important/, "the old goalie photo gives way to a plain tint");

  // another screen: the old one fades out, then the new one comes in
  ctx.document.getElementById("view").innerHTML = `<section class="v15Profile"><img src="${logo("TBL")}"></section>`;
  await tick(200);
  assert.ok(!layer.classList.contains("on"), "the old silhouette fades out first");
  assert.equal(layer.dataset.sil, k, "and is still the old one meanwhile");
  await tick(500);
  assert.equal(layer.dataset.sil, "kucherov", "then the player of the team comes in");
  assert.ok(layer.classList.contains("on"));
  const loadsBefore = ctx.loads.length;
  ctx.document.getElementById("view").insertAdjacentHTML("beforeend", "<p>more</p>");
  await tick(400);
  assert.equal(ctx.loads.length, loadsBefore, "the same screen redrawn: nothing is loaded again");
  assert.ok(layer.classList.contains("on"), "and nothing blinks");

  // the settings switch
  ctx.window.localStorage.setItem("hoh-bg-sil", "0");
  ctx.window.dispatchEvent(new ctx.window.Event("hoh-bg-sil-change"));
  assert.ok(!html.classList.contains("hohSil"), "switched off: gone at once");
  ctx.window.localStorage.setItem("hoh-bg-sil", "1");
  ctx.window.dispatchEvent(new ctx.window.Event("hoh-bg-sil-change"));
  await tick(30);
  assert.ok(html.classList.contains("hohSil"), "and back");
  assert.ok(layer.classList.contains("on"));
  ctx.window.close();

  const off = makeApp({ stored: { "hoh-bg-sil": "0" } });
  await tick(60);
  assert.ok(!off.document.documentElement.classList.contains("hohSil"), "a person who switched it off does not see it");
  assert.ok(!layerOf(off), "nothing is even added");
  assert.equal(off.loads.length, 0, "nor loaded");
  off.window.close();
}

// ---- 5) the players tab: a big number and a follow button on the left of it -------------------------------------------------------
{
  const rows = [[8478864, "Кирилл Капризов", "12"], [8471214, "Александр Овечкин", "8.5 млн"], [8476453, "Никита Кучеров", "7"]];
  const ctx = makeApp({ tab: "players", html: playersHtml(rows), follows: [{ subscription_id: 77, subject_type: "player", subject_key: "8476453" }, { subscription_id: 78, subject_type: "team", subject_key: "MIN" }] });
  let rowClicks = 0;
  ctx.document.querySelectorAll(".playerRow").forEach((r) => r.addEventListener("click", () => { rowClicks += 1; }));
  await tick(1300);
  const values = [...ctx.document.querySelectorAll(".playerSortValue")];
  assert.equal(text(values[0].querySelector("b")), "12", "the number is big");
  assert.ok(!values[0].querySelector("small"));
  assert.equal(text(values[1].querySelector("b")), "8.5", "the money: the number big…");
  assert.equal(text(values[1].querySelector("small")), "млн", "…and the unit small under it");
  const css = ctx.document.getElementById("v28css").textContent;
  const size = Number(/\.playerRow \.playerSortValue b\{font-size:(\d+)px;font-weight:900/.exec(css)[1]);
  assert.ok(size >= 22, `much bigger than before (${size}px)`);
  assert.match(css, /\.playerRow \.playerSortValue\{[^}]*color:#5b21b6!important;font-weight:900!important/, "a deep violet, bold, on the light theme");
  assert.match(css, /html:not\(\.v15Light\) \.playerRow \.playerSortValue\{color:#cdb9ff!important\}/, "a light one on the dark theme");
  assert.match(css, /html \.playerRow \.playerSortValue b\{color:inherit!important\}/, "the number keeps the violet: the black of the other bold texts of a row (.v15Light .playerRow b) does not win");
  assert.match(css, /html\.hohSil \.app\{background:transparent!important\}/, "the light theme paints the app solid (.v15Light .app): with the silhouettes on it is see-through");

  const buttons = [...ctx.document.querySelectorAll(".v28Fol")];
  assert.equal(buttons.length, 3, "a button in every row");
  buttons.forEach((b, i) => assert.equal(b.nextElementSibling, values[i], "right on the left of the number"));
  assert.deepEqual(buttons.map((b) => text(b)), ["+", "+", "✓"], "a followed player has a tick (a team follow does not count)");
  assert.ok(buttons[2].classList.contains("on"));
  assert.equal(buttons[0].getAttribute("aria-label"), "Подписаться на игрока");
  assert.equal(buttons[2].getAttribute("aria-pressed"), "true");

  // follow
  buttons[0].click();
  await tick(30);
  assert.equal(rowClicks, 0, "the tap does not open the player");
  assert.deepEqual(ctx.calls.filter((c) => c.method === "POST").map((c) => c.body), [{ type: "player", key: "8478864" }]);
  assert.equal(text(buttons[0]), "✓", "the plus turns into a tick");
  assert.ok(buttons[0].classList.contains("on"));
  assert.equal(ctx.changes.length, 1, "the other screens are told");
  // unfollow
  buttons[2].click();
  await tick(30);
  assert.deepEqual(ctx.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["/v2/subscriptions/77"]);
  assert.equal(text(buttons[2]), "+", "and back to a plus");
  assert.ok(!ctx.box.follows.some((s) => s.subscription_id === 77));
  assert.equal(rowClicks, 0);

  // the list is drawn again (another sort): the new rows get their buttons and big numbers, the follows are remembered
  ctx.document.getElementById("view").innerHTML = playersHtml([[8478864, "Кирилл Капризов", "5"], [8480830, "Андрей Свечников", "3"]]);
  await tick(300);
  const again = [...ctx.document.querySelectorAll(".v28Fol")];
  assert.equal(again.length, 2, "a redrawn list is decorated again");
  assert.deepEqual(again.map((b) => text(b)), ["✓", "+"], "Kaprizov is still followed");
  assert.equal(text(ctx.document.querySelector(".playerSortValue b")), "5");
  ctx.window.close();

  // outside of Telegram: a tap explains, nothing is sent
  const out = makeApp({ tab: "players", html: playersHtml(rows), followsFail: true });
  await tick(1300);
  const btn = out.document.querySelector(".v28Fol");
  assert.equal(text(btn), "+");
  btn.click();
  await tick(30);
  assert.deepEqual(out.alerts, ["Подписки доступны при открытии из Telegram-бота"]);
  assert.equal(out.calls.filter((c) => c.method !== "GET").length, 0);
  assert.ok(!btn.disabled, "the button is usable again");
  out.window.close();
}

console.log("backdrop validation passed");
