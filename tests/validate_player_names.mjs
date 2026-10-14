// Russian names of players: Sports.ru first, the admins' corrections from the bot on top, a careful transliteration only for the
// few players Sports.ru does not know. Before: the name job broke on a foreign key (a Sports.ru name for a player not in `players`)
// and failed every minute since 21 September, and the roster job never replaced a stored letter-by-letter name — the app showed
// "Масон Лохреи", "Еммитт Финние" and even other players' names. Runs on SQLite with the tables of the real migrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import sportsRu from "../ru_full_names.json" with { type: "json" };
import { transliterateName, legacyTransliterate, resolveRuName, mergedNames, yearsWord } from "../cloudflare-worker/src/telegram-center-player-names.js";
import { runCenterNameMaintenance } from "../cloudflare-worker/src/telegram-center-name-maintenance.js";
import { runCenterRosterMaintenance } from "../cloudflare-worker/src/telegram-center-roster-maintenance.js";
import { handleAdminMessage, handleAdminCallback } from "../cloudflare-worker/src/telegram-center-admin-bot.js";
import { handleTelegramCenterV9Enhancer } from "../cloudflare-worker/src/telegram-center-v9-enhancer.js";

// ---- 1) the transliteration for players Sports.ru does not know ------------------------------------------------------------------------
assert.equal(legacyTransliterate("Emmitt Finnie"), "Еммитт Финние", "the old rule is kept only to recognise its output");
assert.equal(legacyTransliterate("Mason Lohrei"), "Масон Лохреи");
for (const [en, ru] of [["Emmitt Finnie", "Эммитт Финни"], ["Justin Dowling", "Джастин Доулинг"], ["Kyle MacLean", "Кайл Маклин"], ["Mike Benning", "Майк Беннинг"], ["Gage Goncalves", "Гейдж Гонкалвес"], ["Ethan Edwards", "Этан Эдуардс"], ["Dylan Peterson", "Дилан Петерсон"], ["Cole Caufield", "Коул Кауфилд"]]) {
  assert.equal(transliterateName(en), ru, en);
}
const nygard = transliterateName("Michael Brandsegg-Nygård");
assert.ok(!/[a-zåäö]/i.test(nygard), `no Latin letters left: ${nygard}`);
assert.equal(transliterateName(""), null);
assert.deepEqual([1, 2, 4, 5, 11, 14, 21, 22, 25, 31].map(yearsWord), ["год", "года", "года", "лет", "лет", "лет", "год", "года", "лет", "год"], "21 год, 22 года, 25 лет");

// ---- 2) the order of trust ----------------------------------------------------------------------------------------------------------------
const LOHREI = 8482511, HOGLANDER = 8481535, DOWLING = 8475413;
assert.equal(sportsRu[String(LOHREI)], "Мэйсон Лорей");
assert.equal(sportsRu[String(HOGLANDER)], "Нильс Хегландер");
assert.equal(sportsRu[String(DOWLING)], undefined, "a player Sports.ru does not know");
const fix = new Map([[String(LOHREI), "Мейсон Лорей"]]);
assert.deepEqual(resolveRuName(LOHREI, "Mason Lohrei", fix), { name: "Мейсон Лорей", source: "admin" }, "an admin's correction wins");
assert.deepEqual(resolveRuName(LOHREI, "Mason Lohrei", new Map()), { name: "Мэйсон Лорей", source: "sportsru" });
assert.deepEqual(resolveRuName(DOWLING, "Justin Dowling", new Map()), { name: "Джастин Доулинг", source: "translit" });
assert.equal(mergedNames(fix)[String(LOHREI)], "Мейсон Лорей");
assert.equal(mergedNames(fix)[String(HOGLANDER)], "Нильс Хегландер");

// ---- the database --------------------------------------------------------------------------------------------------------------------------
const MIG = new URL("../migrations/", import.meta.url);
const migration = (file) => fs.readFileSync(new URL(file, MIG), "utf8");
const createOf = (file, table) => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migration(file));
  assert.ok(m, `${table} in ${file}`);
  return m[0];
};
const TEAMS = ["ANA", "BOS", "BUF", "CGY", "CAR", "CHI", "COL", "CBJ", "DAL", "DET", "EDM", "FLA", "LAK", "MIN", "MTL", "NSH", "NJD", "NYI", "NYR", "OTT", "PHI", "PIT", "SJS", "SEA", "STL", "TBL", "TOR", "UTA", "VAN", "VGK", "WSH", "WPG"];
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const t of ["teams", "players", "telegram_users"]) raw.exec(createOf("0001_hoh_data_core.sql", t));
  raw.exec(createOf("0010_data_core_meta.sql", "data_core_meta"));
  raw.exec(createOf("0013_center_profiles_games_subscriptions.sql", "player_profile_meta"));
  raw.exec("ALTER TABLE player_profile_meta ADD COLUMN birth_date TEXT; ALTER TABLE player_profile_meta ADD COLUMN height_cm INTEGER; ALTER TABLE player_profile_meta ADD COLUMN weight_kg INTEGER;");
  raw.exec(migration("0049_player_names_admin.sql"));
  for (const t of TEAMS) raw.prepare("INSERT INTO teams(tri_code,name_en) VALUES(?,?)").run(t, t);
  const norm = (v) => (v === undefined ? null : v);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: raw.prepare(sql).all(...args.map(norm)).map((x) => ({ ...x })) }),
    first: async () => { const x = raw.prepare(sql).get(...args.map(norm)); return x ? { ...x } : null; },
    run: async () => { const r = raw.prepare(sql).run(...args.map(norm)); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    raw,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { raw.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
  };
}
const nameOf = (db, id) => db.raw.prepare("SELECT full_name_ru FROM players WHERE player_id=?").get(id)?.full_name_ru ?? null;
const addPlayer = (db, id, en, ru, tri = "BOS") => db.raw.prepare("INSERT INTO players(player_id,full_name_en,full_name_ru,current_team_tri) VALUES(?,?,?,?)").run(id, en, ru, tri);

// ---- 3) the name job: Sports.ru names reach every player, nothing breaks on players that are not in the table -----------------------------
{
  const db = makeDb();
  addPlayer(db, LOHREI, "Mason Lohrei", "Масон Лохреи");
  addPlayer(db, HOGLANDER, "Nils Hoglander", "Джейк Луккини", "VAN");
  addPlayer(db, DOWLING, "Justin Dowling", legacyTransliterate("Justin Dowling"), "NYR");
  addPlayer(db, 1000001, "Old Friend", "Старый Друг", "NYR"); // a name somebody wrote by hand long ago: not touched
  assert.ok(Object.keys(sportsRu).length > 1000, "most Sports.ru names belong to players that are not in this small table");

  const r1 = await runCenterNameMaintenance({ DB: db });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.skipped, false);
  assert.equal(nameOf(db, LOHREI), "Мэйсон Лорей", "the Sports.ru name replaces the letter-by-letter one");
  assert.equal(nameOf(db, HOGLANDER), "Нильс Хегландер", "and a wrong player's name");
  assert.equal(nameOf(db, DOWLING), "Джастин Доулинг", "a player Sports.ru does not know gets the careful transliteration");
  assert.equal(nameOf(db, 1000001), "Старый Друг", "a name that is not the old transliteration stays");
  assert.equal(r1.retransliterated, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM player_profile_meta").get().n, 2, "profile names only for players that exist (no foreign key failure)");
  assert.equal(db.raw.prepare("SELECT full_name_ru FROM player_profile_meta WHERE player_id=?").get(LOHREI).full_name_ru, "Мэйсон Лорей");
  assert.equal((await runCenterNameMaintenance({ DB: db })).skipped, true, "nothing changed: nothing to do");

  db.raw.prepare("INSERT INTO player_name_overrides(player_id,full_name_ru,edited_by) VALUES(?,?,?)").run(LOHREI, "Мейсон Лорей", 1);
  db.raw.prepare("UPDATE players SET full_name_ru='Масон Лохреи' WHERE player_id=?").run(LOHREI);
  const r2 = await runCenterNameMaintenance({ DB: db });
  assert.equal(r2.skipped, false, "a correction of an admin changes the set and runs the job again");
  assert.equal(nameOf(db, LOHREI), "Мейсон Лорей", "the correction wins over Sports.ru");
  assert.equal(r2.overrides, 1);
}

// ---- 4) the roster job: a stored name is replaced by Sports.ru or a correction, never by a transliteration -----------------------------------
{
  const db = makeDb();
  addPlayer(db, LOHREI, "Mason Lohrei", "Масон Лохреи");
  addPlayer(db, DOWLING, "Justin Dowling", "Джастин Даулинг", "NYR");
  addPlayer(db, 8484471, "Emmitt Finnie", "Еммитт Финние", "DET");
  db.raw.prepare("INSERT INTO player_name_overrides(player_id,full_name_ru) VALUES(?,?)").run(8484471, "Эммитт Финни");
  const roster = (tri, i) => {
    const extra = { BOS: [{ id: LOHREI, firstName: { default: "Mason" }, lastName: { default: "Lohrei" }, positionCode: "D" }], NYR: [{ id: DOWLING, firstName: { default: "Justin" }, lastName: { default: "Dowling" }, positionCode: "C" }], DET: [{ id: 8484471, firstName: { default: "Emmitt" }, lastName: { default: "Finnie" }, positionCode: "L" }] }[tri] || [];
    const forwards = Array.from({ length: 20 }, (_, k) => ({ id: 9000000 + i * 100 + k, firstName: { default: "Test" }, lastName: { default: `Player${i}x${k}` }, positionCode: "C" }));
    return { forwards: [...forwards, ...extra.filter((p) => p.positionCode !== "D")], defensemen: extra.filter((p) => p.positionCode === "D"), goalies: [] };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const m = /roster\/([A-Z]{3})\/current/.exec(String(url));
    assert.ok(m, `only NHL rosters are fetched: ${url}`);
    return new Response(JSON.stringify(roster(m[1], TEAMS.indexOf(m[1]))), { status: 200 });
  };
  const r = await runCenterRosterMaintenance({ DB: db }, { force: true });
  globalThis.fetch = realFetch;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(nameOf(db, LOHREI), "Мэйсон Лорей", "Sports.ru replaces the stored letter-by-letter name");
  assert.equal(nameOf(db, 8484471), "Эммитт Финни", "an admin's correction replaces it too");
  assert.equal(nameOf(db, DOWLING), "Джастин Даулинг", "a stored name of a player Sports.ru does not know is not overwritten by a transliteration");
  assert.ok(/^[А-Яа-яЁё0-9 -]+$/.test(nameOf(db, 9000000)), `a new unknown player gets a Cyrillic transliteration: ${nameOf(db, 9000000)}`);
}

// ---- 5) the admins fix names inside the bot ------------------------------------------------------------------------------------------------
{
  const db = makeDb();
  addPlayer(db, LOHREI, "Mason Lohrei", "Мэйсон Лорей");
  addPlayer(db, 8484471, "Emmitt Finnie", "Эммитт Финниэ", "DET");
  addPlayer(db, DOWLING, "Justin Dowling", "Джастин Доулинг", "NYR");
  db.raw.prepare("INSERT INTO player_profile_meta(player_id,full_name_ru) VALUES(?,?)").run(8484471, "Эммитт Финниэ");
  const ADMIN = 52000001, FAN = 52000002, OTHER = 52000003;
  db.raw.prepare("INSERT INTO app_admins(telegram_user_id) VALUES(?)").run(ADMIN);
  db.raw.prepare("INSERT INTO telegram_users(telegram_user_id,username,first_name) VALUES(?,?,?),(?,?,?)").run(ADMIN, "boss", "Босс", OTHER, "editor_two", "Редактор");
  const sent = [], answered = [];
  const send = async (p) => { sent.push(p); return { ok: true }; };
  const answer = async (id, text) => { answered.push(text); };
  const msg = (from, text) => ({ from: { id: from }, chat: { id: from, type: "private" }, text });
  const env = { DB: db };

  assert.equal((await handleAdminMessage(env, msg(FAN, "/name Финни"), send)).handled, false, "not an admin: the command is not his");
  assert.equal(sent.length, 0);
  assert.equal((await handleAdminMessage(env, msg(ADMIN, "/start"), send)).handled, false, "ordinary commands stay with the bot");
  assert.equal((await handleAdminMessage(env, msg(ADMIN, "Привет"), send)).handled, false, "ordinary text too");

  await handleAdminMessage(env, msg(ADMIN, "/name финни"), send);
  const found = sent.at(-1);
  assert.match(found.text, /Emmitt Finnie · DET/, "found by the Russian name, lower case");
  assert.match(found.text, /авто-перевод/, "the source of the name is shown");
  assert.deepEqual(found.reply_markup.inline_keyboard[0][0], { text: "✏️ 1. Finnie", callback_data: "nm:8484471" });
  await handleAdminMessage(env, msg(ADMIN, "/name Lohrei"), send);
  assert.match(sent.at(-1).text, /Мэйсон Лорей \(Sports\.ru\)/, "found by the English name");

  assert.equal((await handleAdminCallback(env, { id: "c1", from: { id: FAN }, data: "nm:8484471", message: { chat: { id: FAN } } }, send, answer)).handled, true);
  assert.equal(answered.at(-1), "Только для админов", "a fan cannot press the admin's button");
  await handleAdminCallback(env, { id: "c2", from: { id: ADMIN }, data: "nm:8484471", message: { chat: { id: ADMIN } } }, send, answer);
  assert.match(sent.at(-1).text, /Напишите новое русское имя для Emmitt Finnie/);
  await handleAdminMessage(env, msg(ADMIN, "Emmitt"), send);
  assert.match(sent.at(-1).text, /русскими буквами/, "a Latin name is refused");
  assert.equal(nameOf(db, 8484471), "Эммитт Финниэ");
  await handleAdminMessage(env, msg(ADMIN, "  Эммит   Финни "), send);
  assert.match(sent.at(-1).text, /Готово ✅ Emmitt Finnie → Эммит Финни/);
  assert.equal(nameOf(db, 8484471), "Эммит Финни", "the app's table has the new name at once");
  assert.equal(db.raw.prepare("SELECT full_name_ru FROM player_profile_meta WHERE player_id=8484471").get().full_name_ru, "Эммит Финни");
  assert.deepEqual({ ...db.raw.prepare("SELECT full_name_ru,previous_name_ru,edited_by FROM player_name_overrides WHERE player_id=8484471").get() }, { full_name_ru: "Эммит Финни", previous_name_ru: "Эммитт Финниэ", edited_by: ADMIN }, "the correction is kept with the old name and who made it");
  assert.equal((await handleAdminMessage(env, msg(ADMIN, "ещё текст"), send)).handled, false, "after the edit the bot stops waiting");

  const routes = await handleTelegramCenterV9Enhancer(new Request("https://x.test/api/telegram-center-v9/ru-names"), env, "/api/telegram-center-v9/ru-names");
  assert.equal((await routes.json()).names["8484471"], "Эммит Финни", "the names the app loads carry the correction");

  await handleAdminMessage(env, msg(ADMIN, "/name Finnie"), send);
  assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard[0][1], { text: "↩️ как на Sports.ru", callback_data: "nr:8484471" }, "a corrected name can be returned");
  await handleAdminCallback(env, { id: "c3", from: { id: ADMIN }, data: "nr:8484471", message: { chat: { id: ADMIN } } }, send, answer);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM player_name_overrides").get().n, 0);
  assert.equal(nameOf(db, 8484471), sportsRu["8484471"] || transliterateName("Emmitt Finnie"));

  await handleAdminCallback(env, { id: "c4", from: { id: ADMIN }, data: "nm:8484471", message: { chat: { id: ADMIN } } }, send, answer);
  await handleAdminMessage(env, msg(ADMIN, "/cancel"), send);
  assert.equal((await handleAdminMessage(env, msg(ADMIN, "Иван Иванов"), send)).handled, false, "/cancel stops the edit");

  await handleAdminMessage(env, msg(ADMIN, "/names"), send);
  assert.match(sent.at(-1).text, /Justin Dowling/, "players Sports.ru does not know are listed for checking");
  assert.ok(!/Mason Lohrei/.test(sent.at(-1).text));

  await handleAdminMessage(env, msg(ADMIN, "/admin_add @nobody_here"), send);
  assert.match(sent.at(-1).text, /ещё не запускал бота/);
  await handleAdminMessage(env, msg(ADMIN, "/admin_add @Editor_Two"), send);
  assert.match(sent.at(-1).text, /@editor_two теперь админ/);
  assert.equal((await handleAdminMessage(env, msg(OTHER, "/name Lohrei"), send)).handled, true, "the new admin can fix names");
  await handleAdminMessage(env, msg(ADMIN, "/admins"), send);
  assert.match(sent.at(-1).text, /@boss[\s\S]*@editor_two/);
  await handleAdminMessage(env, msg(ADMIN, "/name zz"), send);
  assert.match(sent.at(-1).text, /никого не нашёл/);
}

console.log("player names validation passed");
