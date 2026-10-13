// The sync of the VK channel keeps working by itself. A VK ID key lives one hour; it used to be renewed only by the deploy's
// discovery call, so an hour after the last deploy the sync stopped — and every failed run unlinked the streams that had not
// started yet from their games (13 October 2026: no VK link on any of the 16 games of the night). Now the key is renewed by the
// sync itself, a key VK refuses is renewed at once, and a failed sync never unlinks anything. Runs on a real SQLite with the
// tables of the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveVkAccessToken } from "../cloudflare-worker/src/telegram-center-vk-auth.js";
import { runVkBroadcastMaintenance as runLegacy } from "../cloudflare-worker/src/telegram-center-vk-maintenance.js";
import { runVkBroadcastMaintenance } from "../cloudflare-worker/src/telegram-center-vk-maintenance-v2.js";

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

const realFetch = globalThis.fetch;
const realNow = Date.now;
let now = Date.parse("2026-10-13T16:00:00Z");
Date.now = () => now;

// ---- the fake VK: VK ID hands out keys, the video API accepts only the keys it calls good ------------------------------------------
const OWNER = -227682170;
const vk = { refreshes: [], videoCalls: [], good: new Set(), next: 1, page: [], idDown: false };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === "https://id.vk.com") {
    const body = new URLSearchParams(String(init.body || ""));
    vk.refreshes.push(body.get("refresh_token"));
    if (vk.idDown) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "test" }), { status: 400 });
    const n = vk.next++;
    vk.good.add(`A${n}`);
    return new Response(JSON.stringify({ access_token: `A${n}`, refresh_token: `R${n + 1}`, expires_in: 3600, state: u.searchParams.get("state") }), { status: 200 });
  }
  if (u.origin === "https://api.vk.com") {
    const token = u.searchParams.get("access_token");
    vk.videoCalls.push(token);
    if (!vk.good.has(token)) return new Response(JSON.stringify({ error: { error_code: 5, error_msg: "User authorization failed: invalid access_token (4)." } }), { status: 200 });
    return new Response(JSON.stringify({ response: { count: vk.page.length, items: vk.page } }), { status: 200 });
  }
  throw new Error("unexpected request " + url);
};

// ---- 1) the key ----------------------------------------------------------------------------------------------------------------------
{
  const db = makeDb();
  const env = { DB: db, VK_ACCESS_TOKEN: "STATIC", VK_REFRESH_TOKEN: "R1", VK_DEVICE_ID: "dev" };
  assert.equal(await resolveVkAccessToken(env), "A1", "no key yet: a fresh one from VK ID, not the fixed one");
  assert.deepEqual(vk.refreshes, ["R1"]);
  assert.equal(await resolveVkAccessToken(env), "A1", "then the saved key");
  assert.equal(vk.refreshes.length, 1, "without asking VK ID again");
  const saved = db.raw.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key='hoh_vk_oauth_access_v1'").get().meta_value;
  assert.ok(!saved.includes("A1"), "the key is stored encrypted");
  now += 57 * 60 * 1000;
  assert.equal(await resolveVkAccessToken(env), "A1", "57 minutes later the key is still good");
  now += 2 * 60 * 1000;
  assert.equal(await resolveVkAccessToken(env), "A2", "a minute before it runs out it is renewed by itself");
  assert.deepEqual(vk.refreshes, ["R1", "R2"], "with the newest refresh key VK ID gave");
  assert.equal(await resolveVkAccessToken(env, { force: true }), "A3", "a forced renewal");
  now += 61 * 60 * 1000;
  vk.idDown = true;
  assert.equal(await resolveVkAccessToken(env), "STATIC", "VK ID down: the fixed key is the fallback");
  await assert.rejects(resolveVkAccessToken(env, { force: true }), /VK ID refresh invalid_grant/, "a forced renewal says why it failed");
  vk.idDown = false;
  assert.equal(await resolveVkAccessToken({ DB: db, VK_ACCESS_TOKEN: "STATIC" }), "STATIC", "no refresh credentials: the fixed key");
  await assert.rejects(resolveVkAccessToken({ DB: db }), /missing_vk_refresh_credentials/);
}

// ---- 2) the sync: a failure unlinks nothing ---------------------------------------------------------------------------------------------
const T = (a, b, day = "14.10.2026") => `${a} — ${b} | Сезон НХЛ 2026/27 | ${day}`;
const live = (id, title) => ({ id, owner_id: OWNER, title, date: 1791878706, type: "live", live_status: "upcoming", duration: 0, image: [{ url: `https://sun9-1.userapi.com/c${id}.jpg`, width: 1280, height: 720 }] });
function seed(db) {
  for (const t of ["UTA", "TOR", "NJD", "DET"]) db.raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(t, t);
  db.raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)").run(2026020102, "20262027", 2, "2026-10-14T01:00:00Z", "FUT", "UTA", "TOR");
  db.raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)").run(2026020090, "20262027", 2, "2026-10-13T23:00:00Z", "FUT", "DET", "NJD");
}
const linkOf = (db, pk) => db.raw.prepare("SELECT source_key FROM game_vk_broadcasts WHERE game_pk=?").get(pk)?.source_key ?? null;
{
  const db = makeDb();
  seed(db);
  vk.page = [live(456251706, T("Юта Мэммот", "Торонто Мэйпл Лифс"))];
  vk.good.add("GOOD");
  const ok = await runLegacy({ DB: db, VK_ACCESS_TOKEN: "GOOD" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(linkOf(db, 2026020102), `${OWNER}_456251706`, "the stream of the night is linked to its game");
  // a short video linked by mistake to the other game: cleaned by a good sync
  db.raw.prepare("INSERT INTO vk_broadcasts(source_key,title,status,web_url,duration_seconds) VALUES(?,?,?,?,?)").run(`${OWNER}_1`, "Детройт — Нью-Джерси", "video", "https://vkvideo.ru/x", 900);
  db.raw.prepare("INSERT INTO game_vk_broadcasts(game_pk,source_key,match_method) VALUES(?,?,?)").run(2026020090, `${OWNER}_1`, "test");

  const failed = await runLegacy({ DB: db, VK_ACCESS_TOKEN: "EXPIRED" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /^VK video\.get 5:/, "VK's own answer comes first, so the caller can renew the key");
  assert.equal(linkOf(db, 2026020102), `${OWNER}_456251706`, "a failed sync keeps the link of the stream that has not started");
  assert.equal(linkOf(db, 2026020090), `${OWNER}_1`, "and touches nothing else");
  const err = JSON.parse(db.raw.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key='hoh_vk_video_last_error'").get().meta_value);
  assert.match(err.error, /VK video\.get 5:/, "the error is recorded");

  const again = await runLegacy({ DB: db, VK_ACCESS_TOKEN: "GOOD" });
  assert.equal(again.ok, true);
  assert.equal(linkOf(db, 2026020102), `${OWNER}_456251706`, "a good sync keeps it too (it is not dropped and re-made every run)");
  assert.equal(again.current.already_mapped, 1);
  assert.equal(linkOf(db, 2026020090), null, "the short video is unlinked by a good sync");
}

// ---- 3) the run of the schedule renews the key by itself and when VK refuses it -------------------------------------------------------
{
  const db = makeDb();
  seed(db);
  vk.page = [live(456251706, T("Юта Мэммот", "Торонто Мэйпл Лифс")), live(456251694, T("Детройт Ред Уингз", "Нью-Джерси Девилз"))];
  const env = { DB: db, VK_ACCESS_TOKEN: "STATIC", VK_REFRESH_TOKEN: "R1", VK_DEVICE_ID: "dev" };
  const before = vk.refreshes.length;
  const r1 = await runVkBroadcastMaintenance(env);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(vk.refreshes.length, before + 1, "the first run gets a key from VK ID");
  assert.ok(!vk.videoCalls.includes("STATIC"), "the fixed key is not used while VK ID works");
  assert.equal(linkOf(db, 2026020102), `${OWNER}_456251706`);
  assert.equal(linkOf(db, 2026020090), `${OWNER}_456251694`);
  // an hour later, no deploy in between: the run renews the key itself
  now += 61 * 60 * 1000;
  const r2 = await runVkBroadcastMaintenance(env);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(vk.refreshes.length, before + 2, "renewed by the sync, without a deploy");
  // VK refuses a key that has not run out yet (renewed elsewhere): the run renews it and tries again
  vk.good.clear();
  const r3 = await runVkBroadcastMaintenance(env);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(vk.refreshes.length, before + 3, "a refused key is renewed at once");
  assert.equal(linkOf(db, 2026020102), `${OWNER}_456251706`, "and the games keep their streams");
  assert.equal(linkOf(db, 2026020090), `${OWNER}_456251694`);
}

globalThis.fetch = realFetch;
Date.now = realNow;
console.log("VK sync validation passed");
