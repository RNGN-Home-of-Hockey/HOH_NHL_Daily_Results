// Live Center v31: the portrait of a player — the hexagon on his page. Since 2026-10-17 (the owner: «Нужны те характеристики из
// NHL 27, которые считаются основными. И под них уже подстраиваем реальные цифры сезона. Пусть рейтинг игры будет основным, а сезон
// и 5 сезонов рядом можно будет нажать») it has three layers on the same six axes:
//   • NHL 27 — the main groups of characteristics of the game EA SPORTS NHL (skating, offense, puck skills, defense, physicality,
//     general; a goalie: high, low, positioning, rebounds, breakaways, skating), each the average of the game's ratings (up to 99).
//     EA publishes the ~300 best rated players; they are kept in player_game_ratings (migration 0057). EA's site did not give
//     them to the Worker (2026-10-17), so GitHub Actions reads them twice a week (tools/import_game_ratings.mjs, the same
//     storeGameRatings below); the Worker's own weekly try stays as the second way;
//   • Сезон — the real numbers of the season under the same axes: the share of the players of his position he is better than,
//     among those with 5+ games (he gets this layer from his 5th game);
//   • 5 сезонов — the same over the last five regular seasons together, among those with 82+ games.
// Skating comes from NHL EDGE (top speed, bursts over 20 mph), loaded daily into nhl_edge_features. The NHL stats reports are read
// every 6 hours into player_season_profiles (the season under its id, the five seasons under "last5"), so the page reads three rows.
import { playerProfileApp } from "./telegram-center-v31-player-profile-ui.js";

export const SCRIPT_PATH = "/telegram-app/v31-player.js";
const API = /^\/api\/telegram-center-v31\/players\/(\d{1,9})\/profile$/;
const NHL_STATS = "https://api.nhle.com/stats/rest/en";
const META_KEY = "player_profiles_v31b"; // b: the axes of the game (a new key, so the first run rebuilds every portrait)
const TRY_KEY = "player_profiles_v31b_try";
const FRESH_MS = 6 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000; // the NHL stats down: the next try in half an hour, not every 5 minutes
export const MIN_GAMES = 5;
export const MIN_FIVE_GAMES = 82;
export const FIVE_KEY = "last5";
const EA_RATINGS = "https://www.ea.com/games/nhl/ratings";
const EA_META = "player_game_ratings_v1";
const EA_TRY = "player_game_ratings_v1_try";
const EA_FRESH_MS = 7 * 86400 * 1000;
const EA_RETRY_MS = 12 * 3600 * 1000;
const MPH_KMH = 1.609344;

// the main groups of the game, as its player pages show them (ea.com/games/nhl/ratings/player-ratings/…)
export const EA_SKATER_GROUPS = {
  skating: ["acceleration", "agility", "balance", "endurance", "speed"],
  offense: ["offensiveAwareness", "slapshotAccuracy", "slapshotPower", "wristshotAccuracy", "wristshotPower"],
  puck: ["deking", "handeye", "passing", "puckControl"],
  defense: ["defensiveAwareness", "shotBlocking", "stickChecking"],
  physical: ["aggression", "bodyChecking", "fightingSkill", "strength"],
  general: ["discipline", "durability", "faceoffs", "poise"],
};
// a goalie: the game puts nearly everything into «Goalkeeping»; its parts make the six axes
export const EA_GOALIE_GROUPS = {
  high: ["glovesideHigh", "sticksideHigh"],
  low: ["glovesideLow", "sticksideLow", "fiveHole"],
  position: ["angles", "vision"],
  rebounds: ["reboundControl", "shotRecover"],
  breakaway: ["breakaway", "pokeCheck", "aggressiveness"],
  skating: ["agility", "speed", "endurance"],
};
export const EA_GOALIE_AXES = [
  { key: "high", label: "Верх" }, { key: "low", label: "Низ" }, { key: "position", label: "Позиция" },
  { key: "rebounds", label: "Добивания" }, { key: "breakaway", label: "Выходы один на один" }, { key: "skating", label: "Катание" },
];

// the axes of a skater, in the order of the hexagon (clockwise from the top): the groups of the game, and under each the real numbers
// that show the same thing on the ice (each part is a percentile among his position; the axis is their average)
export const SKATER_AXES = [
  { key: "skating", label: "Катание", parts: [(r) => r.speedMax, (r) => (r.bursts == null ? null : r.bursts / r.gp)],
    text: (r) => (r.speedMax == null ? "скорость ещё не измерена" : `до ${kmh(r.speedMax)} км/ч${r.bursts == null ? "" : ` · ${fixed(r.bursts / r.gp, 1)} ${word(r.bursts / r.gp, "рывок", "рывка", "рывков")} быстрее 32 км/ч за матч`}`) },
  { key: "offense", label: "Атака", parts: [(r) => r.goals / r.gp, (r) => r.shots / r.gp],
    text: (r) => `${fixed(r.goals / r.gp, 2)} ${word(r.goals / r.gp, "гол", "гола", "голов")} и ${fixed(r.shots / r.gp, 1)} ${word(r.shots / r.gp, "бросок", "броска", "бросков")} за матч` },
  { key: "puck", label: "Владение шайбой", parts: [(r) => r.assists / r.gp],
    text: (r) => `${fixed(r.assists / r.gp, 2)} ${word(r.assists / r.gp, "передача", "передачи", "передач")} за матч` },
  { key: "defense", label: "Оборона", parts: [(r) => (r.takeaways + r.blocks) / r.gp],
    text: (r) => `${fixed((r.takeaways + r.blocks) / r.gp, 1)} ${word((r.takeaways + r.blocks) / r.gp, "отбор или блок", "отбора или блока", "отборов и блоков")} за матч` },
  { key: "physical", label: "Физика", parts: [(r) => r.hits / r.gp],
    text: (r) => `${fixed(r.hits / r.gp, 1)} ${word(r.hits / r.gp, "силовой приём", "силовых приёма", "силовых приёмов", "силового приёма")} за матч` },
  { key: "general", label: "Общие", parts: [(r) => r.toi],
    text: (r) => `${clock(r.toi)} на льду за матч` },
];
// a goalie's season and five seasons: his own numbers, shown under the hexagon of the game
export const GOALIE_AXES = [
  { key: "save", label: "Отражения", parts: [(r) => r.savePct], text: (r) => `${(r.savePct * 100).toFixed(1).replace(".", ",")}% отражённых бросков` },
  { key: "gaa", label: "Надёжность", parts: [(r) => -r.gaa], text: (r) => `пропускает ${fixed(r.gaa, 2)} ${word(r.gaa, "гол", "гола", "голов")} за матч` },
  { key: "wins", label: "Победы", parts: [(r) => r.wins / r.gp], text: (r) => `${r.wins} ${word(r.wins, "победа", "победы", "побед")} в ${r.gp} ${word(r.gp, "матче", "матчах", "матчах")}` },
  { key: "load", label: "Нагрузка", parts: [(r) => r.starts], text: (r) => `${r.starts} ${word(r.starts, "старт", "старта", "стартов")}` },
  { key: "shutouts", label: "Сухие", parts: [(r) => r.shutouts / r.gp], text: (r) => `${r.shutouts} ${word(r.shutouts, "сухой матч", "сухих матча", "сухих матчей")}` },
];
const PEERS = { F: "нападающих", D: "защитников", G: "вратарей" };

// 1,14 → "1,14"; 0,50 → "0,5"; 0 → "0"
function fixed(v, d) { return Number(v || 0).toFixed(d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "").replace(".", ","); }
function clock(sec) { const s = Math.round(Number(sec) || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
const kmh = (mph) => (Number(mph) * MPH_KMH).toFixed(1).replace(".", ",");
// a fraction takes the genitive singular: "1,14 гола", "0,43 передачи", "0,4 силового приёма" (frac: when it differs from «2 …»)
function word(n, one, few, many, frac = few) { const v = Math.round((Number(n) || 0) * 100) / 100; if (!Number.isInteger(v)) return frac; const a = Math.abs(Math.trunc(v)) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; }
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const orNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const groupOf = (pos) => { const p = String(pos || "").toUpperCase(); return p === "D" ? "D" : p === "G" ? "G" : "F"; };
// the game writes CEN, LW, RW, LD, RD, G
export const gamePositionGroup = (pos) => { const p = String(pos || "").toUpperCase(); return p === "G" ? "G" : p === "LD" || p === "RD" || p === "D" ? "D" : "F"; };

// share of the others that the value beats (ties count half), 0..100
export function percentile(value, others) {
  if (!others.length) return null;
  let below = 0, equal = 0;
  for (const o of others) { if (o < value) below++; else if (o === value) equal++; }
  return Math.round((100 * (below + equal / 2)) / others.length);
}

// the reports of the NHL stats API (+ EDGE skating) → one portrait layer per player
export function computeProfiles({ summary = [], realtime = [], toi = [], goalies = [], edge = new Map() }, { minGames = MIN_GAMES } = {}) {
  const rt = new Map(realtime.map((r) => [Number(r.playerId), r]));
  const ti = new Map(toi.map((r) => [Number(r.playerId), r]));
  const skaters = summary.map((s) => {
    const id = Number(s.playerId);
    const r = rt.get(id) || {};
    const t = ti.get(id) || {};
    const e = edge.get(id) || {};
    return {
      id, group: groupOf(s.positionCode), gp: num(s.gamesPlayed), goals: num(s.goals), assists: num(s.assists), shots: num(s.shots),
      toi: num(s.timeOnIcePerGame || t.timeOnIcePerGame), hits: num(r.hits), blocks: num(r.blockedShots), takeaways: num(r.takeaways),
      speedMax: orNull(e.speedMax), bursts: orNull(e.bursts),
    };
  }).filter((x) => x.id && x.gp > 0);
  const keepers = goalies.map((g) => ({
    id: Number(g.playerId), group: "G", gp: num(g.gamesPlayed), starts: num(g.gamesStarted), wins: num(g.wins), shutouts: num(g.shutouts),
    savePct: num(g.savePct), gaa: num(g.goalsAgainstAverage),
  })).filter((x) => x.id && x.gp > 0);
  const out = [];
  const valueOf = (part, x) => { const v = part(x); return v === null || v === undefined || !Number.isFinite(v) ? null : v; };
  const build = (list, axes, group) => {
    const peers = list.filter((x) => x.group === group && x.gp >= minGames);
    const columns = axes.map((a) => a.parts.map((part) => peers.map((x) => valueOf(part, x)).filter((v) => v !== null)));
    for (const x of list.filter((p) => p.group === group)) {
      const ax = {};
      axes.forEach((a, i) => {
        const pcts = a.parts.map((part, j) => { const v = valueOf(part, x); return v === null ? null : percentile(v, columns[i][j]); }).filter((v) => v !== null);
        ax[a.key] = pcts.length ? Math.round(pcts.reduce((s, v) => s + v, 0) / pcts.length) : null;
      });
      out.push({ player_id: x.id, pos_group: group, games: x.gp, axes: ax, peers: peers.length, raw: x });
    }
  };
  build(skaters, SKATER_AXES, "F");
  build(skaters, SKATER_AXES, "D");
  build(keepers, GOALIE_AXES, "G");
  return out;
}

// a stored layer → what the page shows: every axis with its percentile and the real numbers behind it
export function layerOf(stored, axes) {
  const raw = { ...stored.raw, gp: stored.games || stored.raw.gp };
  return axes.map((a) => {
    const pct = stored.axes[a.key] ?? null;
    return { key: a.key, label: a.label, pct, text: pct === null && a.key !== "skating" ? "" : a.text(raw) };
  });
}

// the game's ratings → the averages of its main groups
export function gameGroups(stats, goalie) {
  const out = {};
  for (const [key, attrs] of Object.entries(goalie ? EA_GOALIE_GROUPS : EA_SKATER_GROUPS)) {
    const vals = attrs.map((k) => Number(stats && stats[k])).filter((v) => Number.isFinite(v) && v > 0);
    out[key] = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  }
  return out;
}
export function gameLayer(row) {
  if (!row) return null;
  let groups;
  try { groups = JSON.parse(row.groups_json) || {}; } catch { return null; }
  const axes = gamePositionGroup(row.position) === "G" ? EA_GOALIE_AXES : SKATER_AXES;
  return { game: String(row.game || "NHL"), overall: Number(row.overall) || null, axes: axes.map((a) => ({ key: a.key, label: a.label, value: groups[a.key] ?? null })) };
}

async function report(fetcher, path, exp, sort, aggregate = false) {
  const r = await fetcher(`${NHL_STATS}/${path}?isAggregate=${aggregate}&isGame=false&start=0&limit=-1&sort=${sort}&cayenneExp=${encodeURIComponent(exp)}`, { headers: { Accept: "application/json", "User-Agent": "HOH-NHL-Center/31" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`nhl_stats_${path}_${r.status}`);
  const d = await r.json();
  return Array.isArray(d?.data) ? d.data : [];
}

export function currentSeason(now = Date.now()) {
  const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return m >= 9 ? `${y}${y + 1}` : `${y - 1}${y}`;
}
// "20262027" → the five seasons up to it, the newest first
export const lastSeasons = (season, n = 5) => { const y = Number(String(season).slice(0, 4)); return Array.from({ length: n }, (_, i) => `${y - i}${y - i + 1}`); };

// NHL EDGE skating (nhl_edge_features): the season's own row; the five seasons take his best top speed
export async function loadEdge(db, seasons) {
  const rows = (await db.prepare(`SELECT season_id,entity_id,skating_speed_max_mph AS speed,bursts_over_20 AS bursts FROM nhl_edge_features
    WHERE entity_type='skater' AND game_type=2 AND season_id IN (${seasons.map(() => "?").join(",")});`).bind(...seasons).all().catch(() => ({ results: [] }))).results || [];
  const season = new Map(), five = new Map();
  for (const r of rows) {
    const id = Number(r.entity_id), speed = orNull(r.speed);
    if (String(r.season_id) === seasons[0]) season.set(id, { speedMax: speed, bursts: orNull(r.bursts) });
    const best = five.get(id) || { speedMax: null, bursts: null };
    if (speed !== null && (best.speedMax === null || speed > best.speedMax)) best.speedMax = speed;
    five.set(id, best);
  }
  return { season, five };
}

const setMeta = (db, key, value) => db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(key, value).run();

export async function runPlayerProfileMaintenance(env, { now = Date.now(), force = false, fetcher = fetch, season = currentSeason(now) } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "missing_d1_binding" };
  // the ratings of the game on their own weekly clock; their failure never stops the season portraits
  const game = await refreshGameRatings(env, { now, fetcher }).catch((error) => ({ ok: false, error: String(error?.message || error).slice(0, 120) }));
  if (!game.ok) console.error("v31 game ratings", game.error);
  const last = await db.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=?;`).bind(META_KEY).first().catch(() => null);
  const lastAt = Date.parse(`${String(last?.updated_at || "").replace(" ", "T")}Z`);
  if (!force && Number.isFinite(lastAt) && now - lastAt < FRESH_MS && String(last?.meta_value || "").includes(season)) return { ok: true, skipped: true, reason: "fresh", game };
  const tried = await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?;`).bind(TRY_KEY).first().catch(() => null);
  if (!force && now - Number(tried?.meta_value) < RETRY_MS) return { ok: true, skipped: true, reason: "retry_later", game };
  await setMeta(db, TRY_KEY, String(now));
  const seasons = lastSeasons(season);
  const one = `seasonId=${season} and gameTypeId=2`;
  const all = `seasonId>=${seasons[4]} and seasonId<=${season} and gameTypeId=2`;
  const [summary, realtime, toi, goalies, summary5, realtime5, goalies5] = await Promise.all([
    report(fetcher, "skater/summary", one, "points"),
    report(fetcher, "skater/realtime", one, "hits"),
    report(fetcher, "skater/timeonice", one, "timeOnIce"),
    report(fetcher, "goalie/summary", one, "wins"),
    report(fetcher, "skater/summary", all, "points", true),
    report(fetcher, "skater/realtime", all, "hits", true),
    report(fetcher, "goalie/summary", all, "wins", true),
  ]);
  if (summary.length < 100) return { ok: false, error: "nhl_stats_incomplete", skaters: summary.length };
  const edge = await loadEdge(db, seasons);
  const layers = [
    [season, computeProfiles({ summary, realtime, toi, goalies, edge: edge.season })],
    // the five seasons: only a full answer (a short one would make the strong look weak)
    [FIVE_KEY, summary5.length >= 100 ? computeProfiles({ summary: summary5, realtime: realtime5, goalies: goalies5, edge: edge.five }, { minGames: MIN_FIVE_GAMES }) : []],
  ];
  for (const [key, profiles] of layers) {
    for (let i = 0; i < profiles.length; i += 60) {
      await db.batch(profiles.slice(i, i + 60).map((p) => db.prepare(`
        INSERT INTO player_season_profiles(season_id,player_id,pos_group,games,axes_json,values_json,peers,updated_at)
        VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(season_id,player_id) DO UPDATE SET pos_group=excluded.pos_group,games=excluded.games,axes_json=excluded.axes_json,
          values_json=excluded.values_json,peers=excluded.peers,updated_at=CURRENT_TIMESTAMP;
      `).bind(key, p.player_id, p.pos_group, p.games, JSON.stringify(p.axes), JSON.stringify({ raw: p.raw }), p.peers)));
    }
  }
  await setMeta(db, META_KEY, JSON.stringify({ season, players: layers[0][1].length, five: layers[1][1].length }));
  return { ok: true, season, players: layers[0][1].length, five: layers[1][1].length, game };
}

// ---- the ratings of the game, once a week ------------------------------------------------------------------------------------------
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const findItems = (o, d = 0) => {
  if (!o || typeof o !== "object" || d > 7) return null;
  if (Array.isArray(o.items) && o.items[0] && o.items[0].overallRating != null) return o;
  for (const v of Object.values(o)) { const r = findItems(v, d + 1); if (r) return r; }
  return null;
};
// the game's players → NHL ids: the full name (the team decides between namesakes); else the last name in the same team; else the
// last name and the jersey number
export function matchGamePlayers(items, players, teams) {
  const triByName = new Map((teams || []).map((t) => [norm(t.name_en), String(t.tri_code)]));
  const byName = new Map(), byLast = new Map();
  const add = (map, key, p) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(p); };
  for (const p of players || []) {
    add(byName, norm(p.full_name_en), p);
    add(byLast, norm(p.last_name_en || String(p.full_name_en || "").split(" ").slice(-1)[0]), p);
  }
  const matched = [], missed = [];
  const one = (list) => (list.length === 1 ? list[0] : null);
  for (const x of items || []) {
    const tri = triByName.get(norm(x.team && x.team.label)) || null;
    const named = byName.get(norm(`${x.firstName}${x.lastName}`)) || [];
    const sameLast = byLast.get(norm(x.lastName)) || [];
    const p = one(named) || one(named.filter((c) => tri && c.current_team_tri === tri))
      || one(sameLast.filter((c) => tri && c.current_team_tri === tri))
      || one(sameLast.filter((c) => x.jerseyNum != null && Number(c.sweater_number) === Number(x.jerseyNum)));
    if (p) matched.push({ player_id: Number(p.player_id), item: x, tri });
    else missed.push(`${x.firstName} ${x.lastName}`);
  }
  return { matched, missed };
}

// EA's public ratings site: the page gives the build id, its data route gives the list 50 players a page
export async function fetchGameRatings(fetcher = fetch) {
  const headers = { Accept: "text/html,application/json", "User-Agent": "Mozilla/5.0 (compatible; HOH-NHL-Center/31)" };
  const page = await fetcher(EA_RATINGS, { headers, signal: AbortSignal.timeout(15000) });
  if (!page.ok) throw new Error(`ea_ratings_${page.status}`);
  const html = await page.text();
  let buildId = "";
  try { buildId = String(JSON.parse((html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1] || "{}").buildId || ""); } catch { /* below */ }
  if (!/^[\w-]{6,64}$/.test(buildId)) throw new Error("ea_ratings_no_build");
  // the page names older games too: the game is the one it names most
  const counts = new Map();
  for (const m of html.matchAll(/NHL ?(\d{2})\b/g)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  const game = top ? `NHL ${top[0]}` : "NHL";
  const items = [];
  for (let n = 1; n <= 10; n++) {
    const r = await fetcher(`https://www.ea.com/_next/data/${buildId}/en/games/nhl/ratings.json?franchiseSlug=nhl&page=${n}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`ea_ratings_page_${r.status}`);
    const list = findItems((await r.json())?.pageProps);
    if (!list || !list.items.length) break;
    items.push(...list.items);
    if (items.length >= Number(list.totalItems || 0)) break;
  }
  if (items.length < 100) throw new Error(`ea_ratings_incomplete_${items.length}`);
  return { game, items };
}

export async function storeGameRatings(db, { game, items }, now = Date.now()) {
  const [players, teams] = await Promise.all([
    db.prepare(`SELECT player_id,full_name_en,last_name_en,current_team_tri,sweater_number FROM players;`).all(),
    db.prepare(`SELECT tri_code,name_en FROM teams;`).all(),
  ]);
  const { matched, missed } = matchGamePlayers(items, players.results || [], teams.results || []);
  const fetchedAt = new Date(now).toISOString();
  for (let i = 0; i < matched.length; i += 60) {
    await db.batch(matched.slice(i, i + 60).map(({ player_id, item, tri }) => {
      const pos = String(item.position?.shortLabel || "");
      const stats = Object.fromEntries(Object.entries(item.stats || {}).map(([k, v]) => [k, v && typeof v === "object" ? v.value : v]));
      return db.prepare(`INSERT INTO player_game_ratings(player_id,game,ea_id,ea_name,team_tri,position,overall,groups_json,fetched_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(player_id) DO UPDATE SET game=excluded.game,ea_id=excluded.ea_id,ea_name=excluded.ea_name,team_tri=excluded.team_tri,
          position=excluded.position,overall=excluded.overall,groups_json=excluded.groups_json,fetched_at=excluded.fetched_at;`)
        .bind(player_id, game, Number(item.id) || null, `${item.firstName} ${item.lastName}`, tri, pos, Number(item.overallRating) || 0,
          JSON.stringify(gameGroups(stats, gamePositionGroup(pos) === "G")), fetchedAt);
    }));
  }
  await setMeta(db, EA_META, JSON.stringify({ fetched_at: fetchedAt, game, players: matched.length, missed: missed.slice(0, 40) }));
  return { ok: true, game, players: matched.length, missed: missed.length };
}

export async function refreshGameRatings(env, { now = Date.now(), fetcher = fetch, force = false } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "missing_d1_binding" };
  const last = await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?;`).bind(EA_META).first().catch(() => null);
  let lastAt = NaN;
  try { lastAt = Date.parse(JSON.parse(last?.meta_value || "{}").fetched_at); } catch { /* never */ }
  if (!force && Number.isFinite(lastAt) && now - lastAt < EA_FRESH_MS) return { ok: true, skipped: true, reason: "fresh" };
  const tried = await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?;`).bind(EA_TRY).first().catch(() => null);
  if (!force && now - Number(tried?.meta_value) < EA_RETRY_MS) return { ok: true, skipped: true, reason: "retry_later" };
  await setMeta(db, EA_TRY, String(now));
  return storeGameRatings(db, await fetchGameRatings(fetcher), now);
}

function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV31(request, env, path, { now = Date.now() } = {}) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${playerProfileApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  const m = API.exec(path);
  if (!m) return null;
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const id = Number(m[1]);
  const raw = String(new URL(request.url).searchParams.get("season") || "");
  const season = /^20\d{6}$/.test(raw) ? raw : currentSeason(now);
  const current = season === currentSeason(now); // the game's ratings and the five seasons belong to today, not to an old season
  const [rows, rating] = await Promise.all([
    env.DB.prepare(`SELECT season_id,pos_group,games,axes_json,values_json,peers FROM player_season_profiles WHERE season_id IN (?,?) AND player_id=?;`).bind(season, current ? FIVE_KEY : season, id).all(),
    current ? env.DB.prepare(`SELECT game,overall,position,groups_json FROM player_game_ratings WHERE player_id=? LIMIT 1;`).bind(id).first().catch(() => null) : null,
  ]);
  const stored = (key) => {
    const row = (rows.results || []).find((r) => String(r.season_id) === key);
    if (!row) return null;
    try { return { pos_group: row.pos_group, games: Number(row.games) || 0, peers: Number(row.peers) || 0, axes: JSON.parse(row.axes_json), raw: JSON.parse(row.values_json).raw || {} }; } catch { return undefined; }
  };
  const one = stored(season), five = current ? stored(FIVE_KEY) : null;
  if (one === undefined || five === undefined) return json({ ok: false, error: "profile_broken" }, 500);
  const ea = gameLayer(rating);
  const pos = (one || five || {}).pos_group || gamePositionGroup(rating && rating.position);
  const axes = pos === "G" ? GOALIE_AXES : SKATER_AXES;
  const layer = (x, min) => (x && x.games >= min ? { games: x.games, peers: x.peers, axes: layerOf(x, axes) } : null);
  const seasonLayer = layer(one, MIN_GAMES), fiveLayer = layer(five, MIN_FIVE_GAMES);
  // nothing to draw yet (a few games, not in the game): no portrait rather than an empty one
  if (!ea && !seasonLayer && !fiveLayer) return json({ ok: true, season, player_id: id, profile: null }, 200, "public, max-age=300");
  return json({
    ok: true, season, player_id: id,
    profile: {
      pos_group: pos, peers_word: PEERS[pos] || "игроков", ea,
      season: seasonLayer, season_games: one ? one.games : 0, min_games: MIN_GAMES,
      five: fiveLayer, five_games: five ? five.games : 0, min_five_games: MIN_FIVE_GAMES,
    },
  }, 200, "public, max-age=300");
}
