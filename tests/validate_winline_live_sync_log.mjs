// Every live Winline sync leaves a log row: per live NHL game "ok" (priced lines), "no_odds" (the match is in the
// feed but Winline shows no odds) or "absent" (no feed lists it), plus how each feed answered. Added 2026-10-19 to
// explain live-odds freezes after the game (the only freeze so far, LAK@VGK 2026-10-11, could not be explained:
// data_core_meta keeps only the latest sync).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describeLiveGames, listNhlLiveMatches, runWinlineLiveFeedMaintenance } from "../cloudflare-worker/src/winline-live-feed-maintenance.js";

const raw = new DatabaseSync(":memory:");
const dir = new URL("../migrations/", import.meta.url);
for (const name of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(name, dir), "utf8"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: raw.prepare(sql).all(...args).map((x) => ({ ...x })) }),
  first: async () => { const x = raw.prepare(sql).get(...args); return x ? { ...x } : null; },
  run: async () => { raw.prepare(sql).run(...args); return {}; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } };

const now = Date.parse("2026-10-20T00:20:00Z");
const iso = (ms) => new Date(ms).toISOString();
const addGame = (pk, away, home, startMs, state) => raw.prepare("INSERT INTO games(game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri) VALUES(?,?,?,?,?,?,?)")
  .run(pk, "20262027", 2, iso(startMs).replace(".000", ""), state, home, away);
addGame(1, "FLA", "CAR", now - 20 * 60e3, "LIVE");   // priced in the feed
addGame(2, "LAK", "VGK", now - 30 * 60e3, "LIVE");   // in the feed, odds suspended
addGame(3, "BOS", "TOR", now + 20 * 60e3, "FUT");    // not started, not in the feed yet
raw.prepare("INSERT INTO winline_live_sync_log(fetched_at,live_games,mapped_games,games_json,attempts_json) VALUES(?,?,?,?,?)")
  .run(iso(now - 15 * 864e5), 1, 1, "[]", "[]");      // older than 14 days → deleted by the sync

const match = (id, t1, t2, lines) => `<Match Id="${id}" Team1="${t1}" Team2="${t2}" MatchDate="2026-10-20T00:00:00Z" MatchUrl="https://winline.ru/plus/${id}">${lines}</Match>`;
const priced = `<line freetext="Next Goal" name1="1" odd1="1.91" name2="2" odd2="2.05"></line><line freetext="Total" value="5.5" name1="Over" odd1="1.85" name2="Under" odd2="1.95"></line>`;
const xml = `<Winline><Sport Name="Ice Hockey" Id="4"><Country Id="1"><Tournament Name="NHL" Id="7">`
  + match(9001, "Carolina Hurricanes", "Florida Panthers", priced)
  + match(9002, "Vegas Golden Knights", "Los Angeles Kings", "")
  + `</Tournament></Country></Sport></Winline>`;

const present = listNhlLiveMatches(xml);
assert.deepEqual(present.map((p) => [p.event_id, p.team1_tri, p.team2_tri, p.priced]), [["9001", "CAR", "FLA", 2], ["9002", "VGK", "LAK", 0]],
  "a match without odds is still listed");

const calls = [];
const result = await runWinlineLiveFeedMaintenance({ DB }, {
  nowMs: now, force: true,
  fetchImpl: async (url) => {
    calls.push(url);
    if (url.endsWith("/live")) return { ok: false, status: 503, text: async () => "busy" };
    return { ok: true, status: 200, text: async () => xml };
  },
});
assert.equal(result.ok, true);
assert.equal(result.mapped_games, 1);
assert.equal(calls.length, 4, "a game missing from the first feed makes the sync try the other three");

const rows = raw.prepare("SELECT * FROM winline_live_sync_log ORDER BY id").all();
assert.equal(rows.length, 1, "one row per sync, rows older than 14 days are deleted");
const row = rows[0];
assert.equal(row.fetched_at, iso(now));
assert.equal(row.live_games, 3);
assert.equal(row.mapped_games, 1);
const games = Object.fromEntries(JSON.parse(row.games_json).map((g) => [g.pk, g]));
assert.deepEqual(games[1], { pk: 1, m: "FLA@CAR", state: "LIVE", min: 20, s: "ok", feeds: "live_mainsports_eng,liveeng,live_mainsports", lines: 2 });
assert.deepEqual(games[2], { pk: 2, m: "LAK@VGK", state: "LIVE", min: 30, s: "no_odds", feeds: "live_mainsports_eng,liveeng,live_mainsports", lines: 0 });
assert.deepEqual(games[3], { pk: 3, m: "BOS@TOR", state: "FUT", min: -20, s: "absent", feeds: "", lines: 0 });
const attempts = JSON.parse(row.attempts_json);
assert.deepEqual(attempts.map((a) => [a.key, a.status, a.error]), [
  ["live_mainsports_eng", 200, null], ["liveeng", 200, null], ["live_mainsports", 200, null], ["live", 503, "HTTP 503"],
], "how each feed answered is kept");

// the sync itself must survive a broken log (e.g. before the migration is applied)
const noLog = { prepare: (sql) => (sql.includes("winline_live_sync_log") ? { bind: () => ({ run: async () => { throw new Error("no such table"); } }) } : DB.prepare(sql)), batch: DB.batch };
const quiet = console.error; console.error = () => {};
const second = await runWinlineLiveFeedMaintenance({ DB: noLog }, { nowMs: now + 60e3, force: true, fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }) });
console.error = quiet;
assert.equal(second.ok, true);
assert.equal(second.mapped_games, 1);

// describeLiveGames without any feed answer
assert.deepEqual(describeLiveGames([{ game_pk: 5, away_tri: "NYR", home_tri: "ANA", game_state: "LIVE", scheduled_start_utc: "2026-10-20T00:00:00Z" }], { mapped: [], present: [] }, now)
  .map((g) => g.s), ["absent"]);

console.log("validate_winline_live_sync_log: OK");
