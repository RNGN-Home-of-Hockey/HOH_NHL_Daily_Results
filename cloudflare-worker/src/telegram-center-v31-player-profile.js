// Live Center v31: the portrait of a player — the hexagon on his page (the owner: «шестиугольник, где заполнено "оборона,
// большинство и сила", а "атака, меньшинство и лидерство" слабое»). Every axis is the share of the players of his position he is
// better than this season: forwards with forwards, defencemen with defencemen, goalies with goalies. The NHL stats reports of
// the whole league are read every 6 hours and the result is kept in D1 (player_season_profiles), so the page reads one row.
import { playerProfileApp } from "./telegram-center-v31-player-profile-ui.js";

export const SCRIPT_PATH = "/telegram-app/v31-player.js";
const API = /^\/api\/telegram-center-v31\/players\/(\d{1,9})\/profile$/;
const NHL_STATS = "https://api.nhle.com/stats/rest/en";
const META_KEY = "player_profiles_v31";
const TRY_KEY = "player_profiles_v31_try";
const FRESH_MS = 6 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000; // the NHL stats down: the next try in half an hour, not every 5 minutes
export const MIN_GAMES = 3;

// the axes, in the order of the hexagon (clockwise from the top)
export const SKATER_AXES = [
  { key: "attack", label: "Атака", value: (r) => r.goals / r.gp, text: (v) => `${fixed(v, 2)} ${word(v, "гол", "гола", "голов")} за матч` },
  { key: "passing", label: "Пас", value: (r) => r.assists / r.gp, text: (v) => `${fixed(v, 2)} ${word(v, "передача", "передачи", "передач")} за матч` },
  { key: "pp", label: "Большинство", value: (r) => r.ppPoints / r.gp, text: (v) => (v === 0 ? "пока без очков в большинстве" : `${fixed(v, 2)} ${word(v, "очко", "очка", "очков")} в большинстве за матч`) },
  { key: "toi", label: "Лидерство", value: (r) => r.toi, text: (v) => `${clock(v)} на льду за матч` },
  { key: "pk", label: "Меньшинство", value: (r) => r.shToi, text: (v) => (v < 5 ? "почти не играет в меньшинстве" : `${clock(v)} в меньшинстве за матч`) },
  { key: "physical", label: "Сила", value: (r) => (r.hits + r.blocks) / r.gp, text: (v) => `${fixed(v, 1)} ${word(Math.round(v * 10) / 10, "хит или блок", "хита и блока", "хитов и блоков")} за матч` },
];
export const GOALIE_AXES = [
  { key: "save", label: "Отражения", value: (r) => r.savePct, text: (v) => `${(v * 100).toFixed(1).replace(".", ",")}% отражённых бросков` },
  { key: "gaa", label: "Надёжность", value: (r) => -r.gaa, text: (v) => `пропускает ${fixed(-v, 2)} ${word(-v, "гол", "гола", "голов")} за матч` },
  { key: "wins", label: "Победы", value: (r) => r.wins / r.gp, text: (v, r) => `${r.wins} ${word(r.wins, "победа", "победы", "побед")} в ${r.gp} ${word(r.gp, "матче", "матчах", "матчах")}` },
  { key: "load", label: "Нагрузка", value: (r) => r.starts, text: (v) => `${v} ${word(v, "старт", "старта", "стартов")}` },
  { key: "shutouts", label: "Сухие", value: (r) => r.shutouts / r.gp, text: (v, r) => `${r.shutouts} ${word(r.shutouts, "сухой матч", "сухих матча", "сухих матчей")}` },
];
const PEERS = { F: "нападающих", D: "защитников", G: "вратарей" };

// 1,14 → "1,14"; 0,50 → "0,5"; 0 → "0"
function fixed(v, d) { return Number(v || 0).toFixed(d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "").replace(".", ","); }
function clock(sec) { const s = Math.round(Number(sec) || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
// a fraction takes the genitive singular: "1,14 гола", "0,43 передачи"
function word(n, one, few, many) { const v = Math.round((Number(n) || 0) * 100) / 100; if (!Number.isInteger(v)) return few; const a = Math.abs(Math.trunc(v)) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; }
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const groupOf = (pos) => { const p = String(pos || "").toUpperCase(); return p === "D" ? "D" : p === "G" ? "G" : "F"; };

// share of the others that the value beats (ties count half), 0..100
export function percentile(value, others) {
  if (!others.length) return null;
  let below = 0, equal = 0;
  for (const o of others) { if (o < value) below++; else if (o === value) equal++; }
  return Math.round((100 * (below + equal / 2)) / others.length);
}

// the reports of the NHL stats API → one portrait per player
export function computeProfiles({ summary = [], realtime = [], toi = [], goalies = [] }, { minGames = MIN_GAMES } = {}) {
  const rt = new Map(realtime.map((r) => [Number(r.playerId), r]));
  const ti = new Map(toi.map((r) => [Number(r.playerId), r]));
  const skaters = summary.map((s) => {
    const id = Number(s.playerId);
    const r = rt.get(id) || {};
    const t = ti.get(id) || {};
    return {
      id, group: groupOf(s.positionCode), gp: num(s.gamesPlayed), goals: num(s.goals), assists: num(s.assists), ppPoints: num(s.ppPoints),
      toi: num(s.timeOnIcePerGame), shToi: num(t.shTimeOnIcePerGame), hits: num(r.hits), blocks: num(r.blockedShots),
    };
  }).filter((x) => x.id && x.gp > 0);
  const keepers = goalies.map((g) => ({
    id: Number(g.playerId), group: "G", gp: num(g.gamesPlayed), starts: num(g.gamesStarted), wins: num(g.wins), shutouts: num(g.shutouts),
    savePct: num(g.savePct), gaa: num(g.goalsAgainstAverage),
  })).filter((x) => x.id && x.gp > 0);
  const out = [];
  const build = (list, axes, group) => {
    const peers = list.filter((x) => x.group === group && x.gp >= minGames);
    const columns = Object.fromEntries(axes.map((a) => [a.key, peers.map((x) => a.value(x))]));
    for (const x of list.filter((p) => p.group === group)) {
      const ax = {}, values = {};
      for (const a of axes) {
        const v = a.value(x);
        values[a.key] = Math.round(v * 1000) / 1000;
        ax[a.key] = percentile(v, columns[a.key]);
      }
      out.push({ player_id: x.id, pos_group: group, games: x.gp, axes: ax, values, peers: peers.length, raw: x });
    }
  };
  build(skaters, SKATER_AXES, "F");
  build(skaters, SKATER_AXES, "D");
  build(keepers, GOALIE_AXES, "G");
  return out;
}

// the plain words of the page: the three best axes and the two weakest
export function describe(profile) {
  const axes = profile.pos_group === "G" ? GOALIE_AXES : SKATER_AXES;
  const raw = profile.raw || {};
  const items = axes.map((a) => ({ key: a.key, label: a.label, pct: profile.axes[a.key], text: a.text(profile.values[a.key], { ...raw, gp: profile.games }) }))
    .filter((x) => x.pct !== null && x.pct !== undefined);
  const sorted = items.slice().sort((a, b) => b.pct - a.pct);
  const peers = PEERS[profile.pos_group] || "игроков";
  const line = (x) => ({ ...x, note: `лучше ${x.pct}% ${peers}` });
  return {
    axes: axes.map((a) => ({ key: a.key, label: a.label, pct: profile.axes[a.key] ?? null })),
    strengths: sorted.filter((x) => x.pct >= 60).slice(0, 3).map(line),
    weaker: sorted.filter((x) => x.pct < 40).slice(-2).reverse().map(line),
    peers_word: peers,
  };
}

async function report(fetcher, path, season, sort) {
  const exp = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
  const r = await fetcher(`${NHL_STATS}/${path}?isAggregate=false&isGame=false&start=0&limit=-1&sort=${sort}&cayenneExp=${exp}`, { headers: { Accept: "application/json", "User-Agent": "HOH-NHL-Center/31" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`nhl_stats_${path}_${r.status}`);
  const d = await r.json();
  return Array.isArray(d?.data) ? d.data : [];
}

export function currentSeason(now = Date.now()) {
  const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return m >= 9 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

export async function runPlayerProfileMaintenance(env, { now = Date.now(), force = false, fetcher = fetch, season = currentSeason(now) } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "missing_d1_binding" };
  const last = await db.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=?;`).bind(META_KEY).first().catch(() => null);
  const lastAt = Date.parse(`${String(last?.updated_at || "").replace(" ", "T")}Z`);
  if (!force && Number.isFinite(lastAt) && now - lastAt < FRESH_MS && String(last?.meta_value || "").includes(season)) return { ok: true, skipped: true, reason: "fresh" };
  const tried = await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?;`).bind(TRY_KEY).first().catch(() => null);
  if (!force && now - Number(tried?.meta_value) < RETRY_MS) return { ok: true, skipped: true, reason: "retry_later" };
  await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(TRY_KEY, String(now)).run();
  const [summary, realtime, toi, goalies] = await Promise.all([
    report(fetcher, "skater/summary", season, "points"),
    report(fetcher, "skater/realtime", season, "hits"),
    report(fetcher, "skater/timeonice", season, "timeOnIce"),
    report(fetcher, "goalie/summary", season, "wins"),
  ]);
  if (summary.length < 100) return { ok: false, error: "nhl_stats_incomplete", skaters: summary.length };
  const profiles = computeProfiles({ summary, realtime, toi, goalies });
  for (let i = 0; i < profiles.length; i += 60) {
    const chunk = profiles.slice(i, i + 60);
    await db.batch(chunk.map((p) => db.prepare(`
      INSERT INTO player_season_profiles(season_id,player_id,pos_group,games,axes_json,values_json,peers,updated_at)
      VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(season_id,player_id) DO UPDATE SET pos_group=excluded.pos_group,games=excluded.games,axes_json=excluded.axes_json,
        values_json=excluded.values_json,peers=excluded.peers,updated_at=CURRENT_TIMESTAMP;
    `).bind(season, p.player_id, p.pos_group, p.games, JSON.stringify(p.axes), JSON.stringify({ ...p.values, raw: p.raw }), p.peers)));
  }
  await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(META_KEY, JSON.stringify({ season, players: profiles.length })).run();
  return { ok: true, season, players: profiles.length };
}

function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV31(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${playerProfileApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  const m = API.exec(path);
  if (!m) return null;
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const raw = String(new URL(request.url).searchParams.get("season") || "");
  const season = /^20\d{6}$/.test(raw) ? raw : currentSeason();
  const row = await env.DB.prepare(`SELECT pos_group,games,axes_json,values_json,peers,updated_at FROM player_season_profiles WHERE season_id=? AND player_id=? LIMIT 1;`).bind(season, Number(m[1])).first();
  if (!row) return json({ ok: true, season, player_id: Number(m[1]), profile: null }, 200, "public, max-age=300");
  let axes = {}, values = {};
  try { axes = JSON.parse(row.axes_json); values = JSON.parse(row.values_json); } catch { return json({ ok: false, error: "profile_broken" }, 500); }
  const profile = { pos_group: row.pos_group, games: Number(row.games) || 0, axes, values, raw: values.raw || {}, peers: Number(row.peers) || 0 };
  return json({
    ok: true, season, player_id: Number(m[1]),
    profile: { pos_group: profile.pos_group, games: profile.games, peers: profile.peers, low_sample: profile.games < MIN_GAMES, updated_at: row.updated_at, ...describe(profile) },
  }, 200, "public, max-age=300");
}
