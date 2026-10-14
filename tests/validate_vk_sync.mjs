// The sync of the VK channel keeps working by itself. A VK ID key lives one hour; it used to be renewed only by the deploy's
// discovery call, so an hour after the last deploy the sync stopped — and every failed run unlinked the streams that had not
// started yet from their games (13 October 2026: no VK link on any of the 16 games of the night). Now the key is renewed by the
// sync itself, a key VK refuses is renewed at once, and a failed sync never unlinks anything. Runs on a real SQLite with the
// tables of the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveVkAccessToken, storeVkLogin } from "../cloudflare-worker/src/telegram-center-vk-auth.js";
import { handleVkOauthStore, handleVkOauthHelper } from "../cloudflare-worker/src/vk-oauth-helper.js";
import { createHash } from "node:crypto";
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
const vk = { refreshes: [], devices: [], videoCalls: [], good: new Set(), next: 1, page: [], idDown: false };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === "https://id.vk.com") {
    const body = new URLSearchParams(String(init.body || ""));
    vk.refreshes.push(body.get("refresh_token"));
    vk.devices.push(u.searchParams.get("device_id"));
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

// ---- 4) a new VK login from the owner: one link with a one-time code, no tokens copied by hand ----------------------------------------
{
  const db = makeDb();
  const env = { DB: db, VK_ACCESS_TOKEN: "STATIC", VK_REFRESH_TOKEN: "R1", VK_DEVICE_ID: "old-device" };
  const CODE = "setup-code-7f3a9c1e5b2d";
  const setCode = (code, exp) => db.raw.prepare("INSERT INTO data_core_meta(meta_key,meta_value) VALUES('hoh_vk_oauth_setup_code_v1',?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value").run(JSON.stringify({ hash: createHash("sha256").update(code).digest("hex"), exp }));
  const meta = (k) => db.raw.prepare("SELECT meta_value FROM data_core_meta WHERE meta_key=?").get(k)?.meta_value ?? null;
  const post = async (body, method = "POST") => {
    const res = await handleVkOauthStore(new Request("https://x.test/vk-oauth/store", { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined }), env, "/vk-oauth/store");
    return { status: res.status, body: await res.json() };
  };
  const login = { code: CODE, access_token: "NEW-ACCESS-1", refresh_token: "NEW-REFRESH-1", device_id: "new-device-42", expires_in: 3600 };
  vk.page = [live(456251723, T("Даллас Старз", "Колорадо Эвеланш", "15.10.2026"))];
  setCode(CODE, new Date(now + 24 * 3600 * 1000).toISOString());

  assert.equal(await handleVkOauthStore(new Request("https://x.test/vk-oauth"), env, "/vk-oauth"), null, "only its own path");
  assert.equal((await post({}, "GET")).status, 405);
  assert.equal((await post({ ...login, code: "wrong-code-000000" })).body.error, "link_expired_or_used", "a wrong code stores nothing");
  assert.equal((await post({ ...login, refresh_token: "" })).status, 400, "all three keys are needed");
  const refused = await post(login);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { ok: false, error: "vk_access_denied" }, "a key that does not open the Home of Hockey videos is refused, with a plain answer (no inner details)");
  assert.equal(meta("hoh_vk_oauth_device_v1"), null, "and nothing is stored");
  assert.ok(meta("hoh_vk_oauth_setup_code_v1"), "the link still works after a refused key");

  vk.good.add("NEW-ACCESS-1");
  vk.page = [];
  assert.equal((await post(login)).body.error, "vk_access_denied", "a key that sees no Home of Hockey video at all is refused too");
  vk.page = [live(456251723, T("Даллас Старз", "Колорадо Эвеланш", "15.10.2026"))];
  const ok = await post(login);
  assert.deepEqual([ok.status, ok.body], [200, { ok: true, videos: 1 }], "the owner's key is checked against the channel and kept");
  for (const k of ["hoh_vk_oauth_access_v1", "hoh_vk_oauth_refresh_v1", "hoh_vk_oauth_device_v1"]) {
    assert.ok(meta(k) && !/NEW-|new-device/.test(meta(k)), `${k} is stored encrypted`);
  }
  assert.equal(meta("hoh_vk_oauth_setup_code_v1"), null, "the code works once");
  assert.equal((await post(login)).body.error, "link_expired_or_used", "a second try with the same link is refused");
  assert.ok(!JSON.stringify(ok.body).includes("NEW-"), "the answer never echoes a key");

  assert.equal(await resolveVkAccessToken(env), "NEW-ACCESS-1", "the sync uses the new key at once");
  const r = await runVkBroadcastMaintenance(env);
  assert.equal(r.ok, true, JSON.stringify(r));
  now += 59 * 60 * 1000;
  const before = vk.refreshes.length;
  const renewed = await resolveVkAccessToken(env);
  assert.ok(/^A\d+$/.test(renewed), "an hour later it is renewed");
  assert.deepEqual([vk.refreshes.at(-1), vk.devices.at(-1)], ["NEW-REFRESH-1", "new-device-42"], "with the new refresh key and the device of the new login");
  assert.equal(vk.refreshes.length, before + 1);

  setCode("old-code-1234567", new Date(now - 1000).toISOString());
  assert.equal((await post({ ...login, code: "old-code-1234567" })).body.error, "link_expired_or_used", "an expired link is refused");
  assert.equal((await storeVkLogin({ DB: db }, login)).error, "vk_store_unavailable", "no secret to encrypt with: nothing is stored");

  const page = await handleVkOauthHelper(new Request("https://x.test/vk-oauth?code=abc"), "/vk-oauth").text();
  assert.ok(page.includes("fetch('/vk-oauth/store'"), "the login page hands the keys to the Worker when it has a code");
  assert.ok(page.includes("if(setupCode) return saveOnServer(data, device);"), "and does not show them");
  new Function(page.split("<script>")[1].split("</script>")[0]);
}

globalThis.fetch = realFetch;
Date.now = realNow;
console.log("VK sync validation passed");
