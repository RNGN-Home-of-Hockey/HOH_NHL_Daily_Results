// The same two teams on neighbouring days (Dallas — Colorado on 14 and 15 Oct 2026). The live game of the 15th had no stream of its
// own (VK's "started" status was not taken for a game stream, so the sync dropped the link) and the team-pair fallback gave it the
// stream of the 14th — the owner opened a finished 3:2 broadcast while the app said LIVE 2:2. On SQLite with the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { broadcastLengthEligible } from "../cloudflare-worker/src/telegram-center-vk-maintenance.js";
import { findBroadcastByPairTime as productFallback } from "../cloudflare-worker/src/telegram-center-v19-product-data.js";
import { findBroadcastByPairTime as lastGameFallback } from "../cloudflare-worker/src/telegram-center-v18-player-lastgame.js";

// ---- 1) a stream on air and a stream just ended are the game itself -------------------------------------------------------------------
const stream = (status, duration_seconds = 0) => ({ title: "Колорадо Эвеланш — Даллас Старз | Сезон НХЛ 2026/27 | 15.10.2026", status, duration_seconds });
assert.equal(broadcastLengthEligible(stream("upcoming")), true);
assert.equal(broadcastLengthEligible(stream("started")), true, "on air: VK says 'started' — the link must stay");
assert.equal(broadcastLengthEligible(stream("waiting")), true, "just ended, the recording is being made");
assert.equal(broadcastLengthEligible(stream("finished", 11000)), true);
assert.equal(broadcastLengthEligible(stream("failed")), false, "a failed stream is not the game");
assert.equal(broadcastLengthEligible(stream("recorded")), false);

// ---- 2) the fallback by the team pair ------------------------------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const createOf = (file, table) => fs.readFileSync(new URL(file, MIG), "utf8").match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))[0];
const raw = new DatabaseSync(":memory:");
for (const t of ["teams", "games"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
raw.exec(createOf("0016_vk_game_broadcasts.sql", "vk_broadcasts"));
raw.exec(createOf("0016_vk_game_broadcasts.sql", "game_vk_broadcasts"));
for (const t of ["DAL", "COL", "BOS", "SJS"]) raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(t, t);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const db = { prepare: (sql) => stmt(sql) };
const game = (pk, start, state, away, home) => {
  raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)").run(pk, "20262027", 2, start, state, home, away);
  return { game_pk: pk, scheduled_start_utc: start, home_tri: home, away_tri: away };
};
const vk = (id, title, home, away, day, published, status, duration, thumb = `https://sun9-1.userapi.com/s/v1/ig2/${id}.jpg`) =>
  raw.prepare("INSERT INTO vk_broadcasts(source_key,owner_id,video_id,title,published_at,scheduled_at,status,web_url,thumbnail_url,duration_seconds,parsed_home_tri,parsed_away_tri) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`-227682170_${id}`, "-227682170", String(id), title, published, `${day}T00:00:00.000Z`, status, `https://vkvideo.ru/video-227682170_${id}`, thumb, duration, home, away);
const link = (pk, id) => raw.prepare("INSERT INTO game_vk_broadcasts(game_pk,source_key,match_method,match_confidence) VALUES(?,?,?,?)").run(pk, `-227682170_${id}`, "title_teams_calendar_date", 1);
const unlink = (id) => raw.prepare("DELETE FROM game_vk_broadcasts WHERE source_key=?").run(`-227682170_${id}`);
const setStream = (id, status, duration) => raw.prepare("UPDATE vk_broadcasts SET status=?,duration_seconds=? WHERE source_key=?").run(status, duration, `-227682170_${id}`);
const key = (b) => (b ? b.source_key.replace("-227682170_", "") : null);

const yesterday = game(2026020100, "2026-10-14T00:30:00Z", "OFF", "COL", "DAL");
const today = game(2026020107, "2026-10-15T00:30:00Z", "CRIT", "DAL", "COL");
vk(456251704, "Даллас Старз — Колорадо Эвеланш | Сезон НХЛ 2026/27 | 14.10.2026", "DAL", "COL", "2026-10-14", "2026-10-14T00:24:09.000Z", "finished", 10898);
vk(456251723, "Колорадо Эвеланш — Даллас Старз | Сезон НХЛ 2026/27 | 15.10.2026", "COL", "DAL", "2026-10-15", "2026-10-15T00:34:20.000Z", "started", 0);
link(2026020100, 456251704);

for (const [name, fallback] of [["the Матчи tab and the match screen", productFallback], ["the last game of a player", lastGameFallback]]) {
  setStream(456251723, "finished", 11000);
  assert.equal(key(await fallback(db, today)), "456251723", `${name}: today's game gets today's stream`);
  assert.equal(key(await fallback(db, yesterday)), "456251704", `${name}: and yesterday's its own`);

  setStream(456251723, "failed", 0);
  assert.equal(await fallback(db, today), null, `${name}: no stream of its own — nothing, never yesterday's finished game (linked to another game)`);
  unlink(456251704);
  assert.equal(await fallback(db, today), null, `${name}: even unlinked, yesterday's stream is nearer to yesterday's game`);
  assert.equal(key(await fallback(db, yesterday)), "456251704", `${name}: the fallback still finds a stream for its own game`);
  link(2026020100, 456251704);
}
// the Матчи tab also takes a stream on air (duration 0)
setStream(456251723, "started", 0);
assert.equal(key(await productFallback(db, today)), "456251723", "on air: today's stream");
setStream(456251723, "waiting", 0);
assert.equal(key(await productFallback(db, today)), "456251723", "just ended: still today's stream");

// teams that meet once: the fallback keeps working a day off (a stream dated by Moscow, a game by its UTC start)
const once = game(2026020200, "2026-10-20T02:00:00Z", "OFF", "BOS", "SJS");
vk(456260000, "Сан-Хосе Шаркс — Бостон Брюинз | Сезон НХЛ 2026/27 | 20.10.2026", "SJS", "BOS", "2026-10-20", "2026-10-20T01:40:00.000Z", "finished", 10800);
assert.equal(key(await productFallback(db, once)), "456260000");
assert.equal(key(await lastGameFallback(db, once)), "456260000");

// highlights follow the same rule
vk(456251800, "Даллас Старз — Колорадо Эвеланш | Хайлайты: обзор матча | 14.10.2026", "DAL", "COL", "2026-10-14", "2026-10-14T04:00:00.000Z", "video", 494);
raw.prepare("DELETE FROM vk_broadcasts WHERE video_id='456251723'").run();
assert.equal(await productFallback(db, today), null, "yesterday's highlights are not today's game either");
assert.equal(await lastGameFallback(db, today), null);
assert.equal(key(await productFallback(db, yesterday)), "456251704");

console.log("vk neighbour games validation passed");
