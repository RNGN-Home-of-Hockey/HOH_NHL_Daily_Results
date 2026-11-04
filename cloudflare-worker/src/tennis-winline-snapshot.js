// Winline's tennis line with its history. The open feed only shows the current price, so a day not
// recorded is lost. Runs on a cron of its own every 10 minutes (worker-entry.js) and stores a price
// only when it changes. Off with TENNIS_WINLINE_SNAPSHOT_ENABLED; the local copy is tools/tennis/winline_pull.py.
const FEED_URL = "https://back.winline.ru/banners/prematch_mainsports";
const USER_AGENT = "RNGN-Matchday-data/0.1";
const SOURCE = "winline-feed";
const BATCH = 100;

function unescapeXml(text) {
  return text.replace(/&(amp|quot|lt|gt|apos|#39);/g, (_, name) => ({ amp: "&", quot: '"', lt: "<", gt: ">", apos: "'", "#39": "'" })[name]);
}

function attributes(tag) {
  const found = {};
  for (const [, key, value] of tag.matchAll(/(\w+)="([^"]*)"/g)) found[key] = unescapeXml(value);
  return found;
}

function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Only the tennis part is searched: the feed holds every sport and weighs about 5 MB.
export function parseTennisFeed(text) {
  const start = text.indexOf('<Sport Name="Теннис"');
  if (start < 0) return { events: [], lines: [] };
  const end = text.indexOf("</Sport>", start);
  const block = text.slice(start, end < 0 ? text.length : end);
  const events = [];
  const lines = new Map();
  for (const [, countryTag, country] of block.matchAll(/<Country ([^>]*)>([\s\S]*?)<\/Country>/g)) {
    const circuit = attributes(countryTag).Name || null;
    for (const [, tournamentTag, tournament] of country.matchAll(/<Tournament ([^>]*)>([\s\S]*?)<\/Tournament>/g)) {
      const name = attributes(tournamentTag).Name || "";
      for (const [, matchTag, body] of tournament.matchAll(/<Match ([^>]*)>([\s\S]*?)<\/Match>/g)) {
        const match = attributes(matchTag);
        if (!match.Id) continue;
        events.push({
          wl_id: match.Id, circuit, tournament: name, team1: match.Team1 || null, team2: match.Team2 || null,
          team1_id: match.Id1 || null, team2_id: match.Id2 || null, start_at: match.MatchDate || null,
          url: match.MatchUrl || null, is_doubles: name.includes("Пары") || (match.Team1 || "").includes("/") ? 1 : 0,
        });
        for (const [, lineTag] of body.matchAll(/<line ([^>]*)>/g)) {
          const line = attributes(lineTag);
          const odd1 = number(line.odd1), odd2 = number(line.odd2);
          if (!line.freetext || !odd1 || !odd2) continue;
          const value = number(line.value);
          const valueKey = value === null ? "" : String(value);
          // A feed can repeat a line within a match; the last one stands.
          lines.set(`${match.Id}|${line.freetext}|${valueKey}`, { wl_id: match.Id, market: line.freetext, value_key: valueKey, value, odd1, odd2 });
        }
      }
    }
  }
  return { events, lines: [...lines.values()] };
}

async function runBatches(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH) await db.batch(statements.slice(i, i + BATCH));
}

export async function storeTennisSnapshot(db, { events, lines }, takenAt) {
  const ids = JSON.stringify(events.map((e) => e.wl_id));
  const { results: knownEvents } = await db.prepare(
    `SELECT wl_id, start_at, team1, team2 FROM tennis_winline_event WHERE wl_id IN (SELECT value FROM json_each(?))`,
  ).bind(ids).all();
  const seen = new Map(knownEvents.map((e) => [e.wl_id, e]));
  const writes = [];
  for (const e of events) {
    const old = seen.get(e.wl_id);
    if (old && old.start_at === e.start_at && old.team1 === e.team1 && old.team2 === e.team2) continue;
    writes.push(db.prepare(
      `INSERT INTO tennis_winline_event (wl_id, circuit, tournament, team1, team2, team1_id, team2_id, start_at, url, is_doubles, first_seen, last_seen, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wl_id) DO UPDATE SET start_at = excluded.start_at, team1 = excluded.team1, team2 = excluded.team2,
         team1_id = excluded.team1_id, team2_id = excluded.team2_id, last_seen = excluded.last_seen`,
    ).bind(e.wl_id, e.circuit, e.tournament, e.team1, e.team2, e.team1_id, e.team2_id, e.start_at, e.url, e.is_doubles, takenAt, takenAt, SOURCE));
  }
  // MAX with bare columns gives the columns of the row holding the maximum, in SQLite.
  const { results: latest } = await db.prepare(
    `SELECT wl_id, market, value_key, odd1, odd2, MAX(taken_at) AS latest FROM tennis_winline_line
     WHERE wl_id IN (SELECT value FROM json_each(?)) GROUP BY wl_id, market, value_key`,
  ).bind(ids).all();
  const prices = new Map(latest.map((l) => [`${l.wl_id}|${l.market}|${l.value_key}`, l]));
  let changed = 0;
  for (const l of lines) {
    const old = prices.get(`${l.wl_id}|${l.market}|${l.value_key}`);
    if (old && old.odd1 === l.odd1 && old.odd2 === l.odd2) continue;
    changed += 1;
    writes.push(db.prepare(
      `INSERT OR REPLACE INTO tennis_winline_line (wl_id, market, value_key, taken_at, value, odd1, odd2, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(l.wl_id, l.market, l.value_key, takenAt, l.value, l.odd1, l.odd2, SOURCE));
  }
  writes.push(db.prepare(`UPDATE tennis_winline_event SET last_seen = ? WHERE wl_id IN (SELECT value FROM json_each(?))`).bind(takenAt, ids));
  writes.push(db.prepare(`INSERT OR REPLACE INTO tennis_winline_fetch (taken_at, events, lines, changed) VALUES (?, ?, ?, ?)`).bind(takenAt, events.length, lines.length, changed));
  await runBatches(db, writes);
  return changed;
}

export async function runTennisWinlineSnapshot(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  if (!env?.DB) return { ok: false, error: "missing_d1_binding" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let text;
  try {
    const response = await fetchImpl(FEED_URL, { signal: controller.signal, headers: { accept: "application/xml,text/xml,*/*", "user-agent": USER_AGENT } });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  const parsed = parseTennisFeed(text);
  if (!parsed.events.length) return { ok: false, error: "no_tennis_in_feed" };
  const takenAt = `${new Date(nowMs).toISOString().slice(0, 19)}+00:00`;
  const changed = await storeTennisSnapshot(env.DB, parsed, takenAt);
  return { ok: true, events: parsed.events.length, lines: parsed.lines.length, changed };
}
