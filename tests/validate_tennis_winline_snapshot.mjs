// Winline's tennis line is kept with its history, on a cron run of its own.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseTennisFeed, runTennisWinlineSnapshot, storeTennisSnapshot } from "../cloudflare-worker/src/tennis-winline-snapshot.js";

const FEED = `<Feed><Sport Name="Футбол" Id="1"><Country Name="Лига"><Tournament Name="Кубок"><Match Team1="А" Team2="Б" Id="9">
<line freetext="Победитель" name1="1" odd1="2.0" name2="2" odd2="2.0"></line></Match></Tournament></Country></Sport>
<Sport Name="Теннис" Id="5"><Country Name="WTA" Id="6"><Tournament Name="Город, Страна" Id="7">
<Match Team1="Альфа А." Team2="Бета &amp; Б." Id1="11" Id2="22" MatchDate="2026-11-05T13:00:00.000+03:00" MatchUrl="https://x/1" islive="0" Id="100">
<line freetext="Победитель" name1="1" odd1="1.60" name2="2" odd2="2.30"></line>
<line freetext="Фора" value="-1.5" name1="1" odd1="1.70" name2="2" odd2="2.10"></line>
<line freetext="Фора" value="-1.5" name1="1" odd1="1.75" name2="2" odd2="2.05"></line>
<line freetext="Тотал" value="20.5" name1="Больше" odd1="1.80" name2="Меньше" odd2="1.95"></line>
<line freetext="Сломанная" name1="1" odd1="" name2="2" odd2="1.5"></line>
</Match></Tournament>
<Tournament Name="Город, Страна, Пары" Id="8"><Match Team1="Альфа А./Гамма Г." Team2="Бета Б./Дельта Д." Id="101">
<line freetext="Победитель" name1="1" odd1="1.90" name2="2" odd2="1.90"></line></Match></Tournament>
</Country></Sport></Feed>`;

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(name, dir), "utf8"));
  const stmt = (sql, args = []) => ({
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
    run: async () => { raw.prepare(sql).run(...args); return {}; },
  });
  return { raw, prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } };
}
const plain = (rows) => rows.map((x) => ({ ...x }));
const respond = (text, status = 200) => async () => ({ ok: status === 200, status, text: async () => text });

// ---- reading the feed
{
  const { events, lines } = parseTennisFeed(FEED);
  assert.deepEqual(events.map((e) => [e.wl_id, e.circuit, e.is_doubles]), [["100", "WTA", 0], ["101", "WTA", 1]]);
  assert.equal(events[0].team2, "Бета & Б.");
  assert.equal(events[0].team1_id, "11");
  assert.equal(lines.length, 4, "a repeated line counts once and a broken one not at all");
  assert.equal(lines.find((l) => l.market === "Фора").odd1, 1.75, "the last repeat stands");
  assert.equal(lines.find((l) => l.market === "Победитель").value_key, "");
  assert.deepEqual(parseTennisFeed("<Feed></Feed>"), { events: [], lines: [] });
}

// ---- a price is stored only when it changes
{
  const db = makeDb();
  const parsed = parseTennisFeed(FEED);
  assert.equal(await storeTennisSnapshot(db, parsed, "t1"), 4);
  assert.equal(await storeTennisSnapshot(db, parsed, "t2"), 0);
  const moved = { events: parsed.events, lines: parsed.lines.map((l) => (l.market === "Победитель" && l.wl_id === "100" ? { ...l, odd1: 1.55 } : l)) };
  assert.equal(await storeTennisSnapshot(db, moved, "t3"), 1);
  assert.deepEqual(plain(db.raw.prepare("SELECT taken_at, odd1 FROM tennis_winline_line WHERE wl_id='100' AND market='Победитель' ORDER BY taken_at").all()),
    [{ taken_at: "t1", odd1: 1.6 }, { taken_at: "t3", odd1: 1.55 }]);
  // back to an earlier price is a change as well: what counts is the last one
  assert.equal(await storeTennisSnapshot(db, parsed, "t4"), 1);
  const event = db.raw.prepare("SELECT first_seen, last_seen, source FROM tennis_winline_event WHERE wl_id='100'").get();
  assert.deepEqual({ ...event }, { first_seen: "t1", last_seen: "t4", source: "winline-feed" });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM tennis_winline_fetch").get().n, 4);
}

// ---- a moved start updates the event and keeps its first sighting
{
  const db = makeDb();
  const parsed = parseTennisFeed(FEED);
  await storeTennisSnapshot(db, parsed, "t1");
  const later = { events: parsed.events.map((e) => (e.wl_id === "100" ? { ...e, start_at: "later" } : e)), lines: parsed.lines };
  await storeTennisSnapshot(db, later, "t2");
  assert.deepEqual({ ...db.raw.prepare("SELECT start_at, first_seen FROM tennis_winline_event WHERE wl_id='100'").get() }, { start_at: "later", first_seen: "t1" });
}

// ---- the run
{
  const db = makeDb(), env = { DB: db };
  const now = Date.parse("2026-11-04T16:30:45Z");
  assert.deepEqual(await runTennisWinlineSnapshot(env, { nowMs: now, fetchImpl: respond(FEED) }), { ok: true, events: 2, lines: 4, changed: 4 });
  assert.equal(db.raw.prepare("SELECT taken_at FROM tennis_winline_fetch").get().taken_at, "2026-11-04T16:30:45+00:00");
  assert.deepEqual(await runTennisWinlineSnapshot(env, { fetchImpl: respond("", 429) }), { ok: false, error: "http_429" });
  assert.deepEqual(await runTennisWinlineSnapshot(env, { fetchImpl: respond("<Feed></Feed>") }), { ok: false, error: "no_tennis_in_feed" });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM tennis_winline_fetch").get().n, 1, "a bad answer stores nothing");
  assert.deepEqual(await runTennisWinlineSnapshot({}), { ok: false, error: "missing_d1_binding" });
}

// ---- more lines than one batch holds
{
  const db = makeDb();
  let batches = 0;
  const batch = db.batch;
  db.batch = async (list) => { batches += 1; assert.ok(list.length <= 100); return batch(list); };
  const event = { wl_id: "1", circuit: "WTA", tournament: "Т", team1: "А", team2: "Б", team1_id: null, team2_id: null, start_at: "x", url: null, is_doubles: 0 };
  const lines = Array.from({ length: 250 }, (_, i) => ({ wl_id: "1", market: "Тотал", value_key: String(i), value: i, odd1: 1.5, odd2: 2.5 }));
  assert.equal(await storeTennisSnapshot(db, { events: [event], lines }, "t1"), 250);
  assert.ok(batches >= 3);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM tennis_winline_line").get().n, 250);
}

// ---- the run is scheduled and has a cron of its own, away from the shared ones
{
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../cloudflare-worker/src/worker-entry.js", import.meta.url), "utf8");
  assert.ok(wrangler.includes('"3,13,23,33,43,53 * * * *"'));
  assert.ok(wrangler.includes('"TENNIS_WINLINE_SNAPSHOT_ENABLED": "1"'));
  assert.ok(entry.includes('cron === "3,13,23,33,43,53 * * * *"'));
  assert.ok(entry.indexOf('"tennis_winline"') < entry.indexOf('if (cron === "* * * * *")'), "it returns before the shared runs");
}

console.log("tennis winline snapshot: ok");
