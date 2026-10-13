// Covers of the VK broadcasts. While VK has not got a picture of a stream yet, it lists an iv.okcdn.ru "getVideoPreview" link that
// never opens (404); for a while the same stream comes with the real picture one minute and the dead link the next. The dead link is
// never stored and never replaces a real picture. In the app a cover that failed to load is tried again ten minutes later, not
// only after a restart. The sync runs on a real SQLite with the tables of the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { bestImage, isDeadVkPreview, runVkBroadcastMaintenance } from "../cloudflare-worker/src/telegram-center-vk-maintenance.js";
import { handleTelegramCenterV19Ui } from "../cloudflare-worker/src/telegram-center-v19-ui.js";

const DEAD = "https://iv.okcdn.ru/getVideoPreview?id=20558708017917&idx=0&type=39&tkn=XKPBK1wFQr6888HGDbix6FPLk2o&fn=vid_w";
const REAL = (n) => `https://sun9-${n}.userapi.com/s/v1/ig2/cover${n}.jpg?quality=95&size=2048x1152`;

// ---- 1) the choice of the picture -----------------------------------------------------------------------------------------------------
assert.ok(isDeadVkPreview(DEAD));
assert.ok(!isDeadVkPreview(REAL(1)));
assert.equal(bestImage([{ url: REAL(1), width: 320, height: 180 }, { url: REAL(2), width: 1280, height: 720 }]), REAL(2), "the largest picture");
assert.equal(bestImage([{ url: DEAD, width: 1920, height: 1080 }, { url: REAL(3), width: 640, height: 360 }]), REAL(3), "a dead preview loses even when it is larger");
assert.equal(bestImage([{ url: DEAD, width: 1920, height: 1080 }]), null, "only a dead preview: no cover");
assert.equal(bestImage(REAL(4)), REAL(4), "a plain link");
assert.equal(bestImage(DEAD), null);
assert.equal(bestImage([]), null);
assert.equal(bestImage(undefined), null);

// ---- 2) the sync of the channel: what lands in the database ----------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migration(file));
  assert.ok(m, `${table} in ${file}`);
  return m[0];
};
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const t of ["teams", "games"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
  raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
  raw.exec(createOf("0016_vk_game_broadcasts.sql", "vk_broadcasts"));
  raw.exec(createOf("0016_vk_game_broadcasts.sql", "game_vk_broadcasts"));
  const norm = (v) => (v === undefined ? null : v);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: raw.prepare(sql).all(...args.map(norm)).map((x) => ({ ...x })) }),
    first: async () => { const x = raw.prepare(sql).get(...args.map(norm)); return x ? { ...x } : null; },
    run: async () => { const r = raw.prepare(sql).run(...args.map(norm)); return { meta: { changes: Number(r.changes) } }; },
  });
  return { raw, prepare: (sql) => stmt(sql) };
}

const OWNER = -227682170;
const item = (id, title, pictures = {}) => ({ id, owner_id: OWNER, title, date: 1791878560, type: "live", live_status: "upcoming", duration: 0, ...pictures });
const db = makeDb();
const env = { DB: db, VK_ACCESS_TOKEN: "test-token" };
const realFetch = globalThis.fetch;
let page = [];
const vkCalls = [];
globalThis.fetch = async (url) => {
  vkCalls.push(String(url));
  assert.match(String(url), /^https:\/\/api\.vk\.com\/method\/video\.get\?/, "only VK is asked");
  return new Response(JSON.stringify({ response: { count: page.length, items: page } }), { status: 200 });
};
const thumb = (id) => db.raw.prepare("SELECT thumbnail_url FROM vk_broadcasts WHERE source_key=?").get(`${OWNER}_${id}`)?.thumbnail_url ?? null;
const sync = async (items) => { page = items; const r = await runVkBroadcastMaintenance(env); assert.equal(r.ok, true, JSON.stringify(r)); };

const T = (a, b) => `${a} — ${b} | Сезон НХЛ 2026/27 | 14.10.2026`;
await sync([
  item(1, T("Детройт Ред Уингз", "Нью-Джерси Девилз"), { image: [{ url: REAL(1), width: 1280, height: 720 }] }),
  item(2, T("Коламбус Блю Джекетс", "Флорида Пантерз"), { image: [{ url: DEAD, width: 1280, height: 720 }] }),
  item(3, T("Юта Мэммот", "Торонто Мэйпл Лифс"), { image: [{ url: DEAD, width: 1280, height: 720 }], first_frame: [{ url: REAL(3), width: 800, height: 450 }] }),
  item(4, T("Каролина Харрикейнз", "Вашингтон Кэпиталз"), { image: [], first_frame_160: [{ url: REAL(4), width: 160, height: 90 }] }),
]);
assert.ok(vkCalls.length >= 1);
assert.equal(thumb(1), REAL(1), "the real cover is stored");
assert.equal(thumb(2), null, "a stream with only the dead preview has no cover yet: the app shows the logos");
assert.equal(thumb(3), REAL(3), "the first frame is used when the picture is dead");
assert.equal(thumb(4), REAL(4), "an empty list of pictures does not hide the first frame");

// the next minute VK gives the dead link for the stream that had a real cover: the real cover stays
await sync([item(1, T("Детройт Ред Уингз", "Нью-Джерси Девилз"), { image: [{ url: DEAD, width: 1280, height: 720 }] })]);
assert.equal(thumb(1), REAL(1), "a dead preview never replaces a real cover");
// VK has got the picture of the second stream at last
await sync([item(2, T("Коламбус Блю Джекетс", "Флорида Пантерз"), { image: [{ url: REAL(2), width: 1280, height: 720 }] })]);
assert.equal(thumb(2), REAL(2), "the cover appears as soon as VK has it");
// a new cover in VK replaces the old one
await sync([item(1, T("Детройт Ред Уингз", "Нью-Джерси Девилз"), { image: [{ url: REAL(9), width: 1280, height: 720 }] })]);
assert.equal(thumb(1), REAL(9), "a changed cover is taken");
// a dead link stored before this fix is dropped the next time the stream is seen
db.raw.prepare("UPDATE vk_broadcasts SET thumbnail_url=? WHERE source_key=?").run(DEAD, `${OWNER}_4`);
await sync([item(4, T("Каролина Харрикейнз", "Вашингтон Кэпиталз"), { image: [{ url: DEAD, width: 1280, height: 720 }] })]);
assert.equal(thumb(4), null, "an old dead link is cleaned");
// and nothing else of the row is lost
const row = db.raw.prepare("SELECT title,status,web_url FROM vk_broadcasts WHERE source_key=?").get(`${OWNER}_4`);
assert.equal(row.status, "upcoming");
assert.equal(row.web_url, `https://vkvideo.ru/video${OWNER}_4`);
globalThis.fetch = realFetch;

// ---- 3) the app forgets a failed cover after ten minutes ------------------------------------------------------------------------------
{
  const v19 = await handleTelegramCenterV19Ui(new Request("https://x.test/telegram-app/v19.js"), "/telegram-app/v19.js").text();
  const line = v19.split("\n").find((l) => l.startsWith("function coverFailures()"));
  assert.ok(line, "the helper is in the layer");
  assert.ok(v19.includes(line + "\ncoverFailures();"), "the memory is set up when the layer loads, before the other layers use it");
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  const { window } = dom;
  let now = Date.parse("2026-10-13T16:00:00Z");
  window.Date.now = () => now;
  window.HOHCoverFailures = new window.Set(["/old.jpg"]);
  window.eval(`${line}\nwindow.coverFailures = coverFailures; coverFailures();`);
  const bad = window.HOHCoverFailures;
  assert.equal(window.coverFailures(), bad, "one memory for all the layers");
  assert.equal(window.HOHCoverFailures || new window.Set(), bad, "the other layers take the same memory");
  assert.ok(bad.has("/old.jpg"), "what failed before is kept");
  const url = "/api/telegram-center-media/vk-cover?source_key=-227682170_456251695";
  assert.ok(!bad.has(url));
  bad.add(url);
  assert.ok(bad.has(url), "a failed cover is not asked again at once");
  now += 9 * 60 * 1000;
  assert.ok(bad.has(url), "nor nine minutes later");
  now += 61 * 1000;
  assert.ok(!bad.has(url), "ten minutes later it is tried again");
  assert.ok(!bad.has("/old.jpg"));
  bad.add(url);
  assert.ok(bad.has(url), "and if it fails again it waits again");
  window.close();
}

console.log("VK covers validation passed");
