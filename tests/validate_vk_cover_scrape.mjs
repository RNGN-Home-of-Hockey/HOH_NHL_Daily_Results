// Covers from the public VK pages (og:image), so the cards and the match of the day get their pictures even when the sync of the
// channel cannot log in to VK. Runs on SQLite with the tables of the real migrations; VK is faked.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ogImageOf, isRealVkCover, runVkCoverScrape } from "../cloudflare-worker/src/telegram-center-vk-cover-scrape.js";

const REAL = "https://sun9-77.vkuserphoto.ru/impg/Uqv2JZn2ikiZeVc/sqTAtg2sfKE.jpg?size=1280x720&quality=95&sign=abc&type=video_thumb";
const page = (img) => `<html><head><meta property="og:title" content="Даллас — Колорадо"/><meta property="og:image" content="${img.replace(/&/g, "&amp;")}"/></head></html>`;

assert.equal(ogImageOf(page(REAL)), REAL, "the picture of the page, entities decoded");
assert.equal(ogImageOf('<meta content="https://x.test/a.jpg" property="og:image">'), "https://x.test/a.jpg", "either order of the attributes");
assert.equal(ogImageOf("<html></html>"), null);
assert.ok(isRealVkCover(REAL));
assert.ok(isRealVkCover("https://sun9-69.userapi.com/s/v1/ig2/L9KNB6evNL7.jpg?quality=95&size=2048x1152"), "the pictures of the VK API are real too");
assert.ok(!isRealVkCover("/images/video/thumbs/video_l.png"), "the grey placeholder of VK");
assert.ok(!isRealVkCover("https://vk.com/images/video/thumbs/video_l.png"));
assert.ok(!isRealVkCover("https://iv.okcdn.ru/getVideoPreview?id=1&fn=vid_w"), "the dead preview link");
assert.ok(!isRealVkCover("http://sun9-77.vkuserphoto.ru/impg/a.jpg"), "https only");
assert.ok(!isRealVkCover("https://evil.test/impg/a.jpg"), "VK hosts only");
assert.ok(!isRealVkCover(null));

const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => migration(file).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
raw.exec("PRAGMA foreign_keys = ON;");
for (const t of ["teams", "games"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
raw.exec(createOf("0016_vk_game_broadcasts.sql", "vk_broadcasts"));
raw.exec(createOf("0016_vk_game_broadcasts.sql", "game_vk_broadcasts"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const db = { prepare: (sql) => stmt(sql) };
for (const t of ["DAL", "COL", "MTL", "WSH", "UTA", "TOR", "BOS", "SJS"]) raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(t, t);
const NOW = Date.parse("2026-10-14T19:00:00Z");
const addGame = (pk, start, away, home, vid, thumb) => {
  raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)").run(pk, "20262027", 2, start, "FUT", home, away);
  raw.prepare("INSERT INTO vk_broadcasts(source_key,owner_id,video_id,title,status,web_url,thumbnail_url) VALUES(?,?,?,?,?,?,?)").run(`-227682170_${vid}`, "-227682170", String(vid), `${away} — ${home}`, "upcoming", "https://vkvideo.ru/x", thumb);
  raw.prepare("INSERT INTO game_vk_broadcasts(game_pk,source_key,match_method) VALUES(?,?,?)").run(pk, `-227682170_${vid}`, "test");
};
addGame(1, "2026-10-15T00:30:00Z", "DAL", "COL", 723, null); // tonight, no picture
addGame(2, "2026-10-14T23:30:00Z", "MTL", "WSH", 722, "https://iv.okcdn.ru/getVideoPreview?id=2&fn=vid_w"); // a dead link
addGame(3, "2026-10-15T01:00:00Z", "UTA", "TOR", 706, null); // VK has only the placeholder so far
addGame(4, "2026-10-15T02:00:00Z", "BOS", "SJS", 724, "https://sun9-1.userapi.com/s/v1/ig2/keep.jpg"); // already has one
addGame(5, "2026-10-20T00:00:00Z", "DAL", "MTL", 800, null); // too far ahead
const thumb = (vid) => raw.prepare("SELECT thumbnail_url FROM vk_broadcasts WHERE video_id=?").get(String(vid)).thumbnail_url;

const asked = [];
const vk = { pages: { "723": page(REAL), "722": page(REAL.replace("Uqv2", "WSH0")), "706": page("/images/video/thumbs/video_l.png") }, down: false };
const fetcher = async (url, init) => {
  asked.push({ url, ua: init.headers["User-Agent"] });
  if (vk.down) throw new Error("timeout");
  const id = /video-227682170_(\d+)$/.exec(url)[1];
  return new Response(vk.pages[id] || "<html></html>", { status: 200 });
};

const r1 = await runVkCoverScrape({ DB: db }, { now: NOW, fetcher });
assert.deepEqual(r1, { ok: true, candidates: 3, fetched: 3, saved: 2, placeholder: 1, failed: 0 }, "the three streams of the night without a picture, nothing far ahead, nothing that has one");
assert.equal(thumb(723), REAL, "the picture of the page is taken");
assert.equal(thumb(722), REAL.replace("Uqv2", "WSH0"), "a dead link is replaced");
assert.equal(thumb(706), null, "the placeholder is not a cover");
assert.equal(thumb(724), "https://sun9-1.userapi.com/s/v1/ig2/keep.jpg", "a real picture is never touched");
assert.ok(asked.every((a) => a.ua === "TelegramBot (like TwitterBot)"), "VK answers the page to the Telegram link preview agent");
assert.deepEqual(asked.map((a) => a.url), ["https://vk.com/video-227682170_722", "https://vk.com/video-227682170_723", "https://vk.com/video-227682170_706"], "the soonest games first");

asked.length = 0;
const r2 = await runVkCoverScrape({ DB: db }, { now: NOW + 5 * 60 * 1000, fetcher });
assert.deepEqual([r2.candidates, r2.fetched], [1, 0], "the page without a picture is asked again only after 15 minutes");
vk.pages["706"] = page(REAL.replace("Uqv2", "UTA0"));
const r3 = await runVkCoverScrape({ DB: db }, { now: NOW + 16 * 60 * 1000, fetcher });
assert.deepEqual([r3.fetched, r3.saved], [1, 1]);
assert.equal(thumb(706), REAL.replace("Uqv2", "UTA0"), "the cover comes as soon as VK shows it");

raw.prepare("UPDATE vk_broadcasts SET thumbnail_url=NULL WHERE video_id IN ('723','722','706')").run();
vk.down = true;
const r4 = await runVkCoverScrape({ DB: db }, { now: NOW + 60 * 60 * 1000, fetcher, limit: 2 });
assert.deepEqual([r4.fetched, r4.failed, r4.saved], [2, 2, 0], "VK down: honest failures, and no more pages than the limit");

console.log("vk cover scrape validation passed");
