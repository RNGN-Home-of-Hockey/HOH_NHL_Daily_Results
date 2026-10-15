// Live Center v32: the game while it is on (package 2 of the owner's list, 2026-10-15).
//   - «Что я пропустил»: the score, the period, the goals so far, the shots and the penalties in ten seconds;
//   - «На что поставить сейчас»: the live Winline line of the game (the winner, the next goal, the total) with a hook from the
//     form of the teams («Юта выиграла 4 матча подряд»), so the fan does not wait for the offers of the broadcast;
//   - the match of the day goes first on the home page while it is live (the UI layer moves it).
//   GET /api/telegram-center-v32/games/<game_pk>/live
import { liveApp } from "./telegram-center-v32-live-ui.js";
import { fetchJson, loadNames } from "./telegram-center-v26-goals.js";
import { stateInfo, periodInfo, playerIdsOf } from "./telegram-center-v26-goals-data.js";

export const SCRIPT_PATH = "/telegram-app/v32-live.js";
const API = /^\/api\/telegram-center-v32\/games\/(\d{1,12})\/live$/;
const NHL_LANDING = (pk) => `https://api-web.nhle.com/v1/gamecenter/${pk}/landing`;
export const FRESH_SECONDS = 180; // a live price older than this is not shown: it would mislead
const CACHE_SECONDS = 15;

const text = (v) => (v && typeof v === "object" ? String(v.default ?? "").trim() : String(v ?? "").trim());
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ---- «Что я пропустил» ------------------------------------------------------------------------------------------------------
export function recapOf(landing, names = null) {
  if (!landing) return null;
  const nameOf = (id, first, last) => (id && names && names.get(Number(id))) || [text(first), text(last)].filter(Boolean).join(" ") || null;
  const goals = [];
  for (const block of landing?.summary?.scoring || []) {
    const period = periodInfo(block?.periodDescriptor);
    for (const g of block?.goals || []) {
      goals.push({
        period: period.short_ru,
        time: period.type === "SO" ? null : text(g?.timeInPeriod) || null, // the clock of a shootout is always 00:00
        team: text(g?.teamAbbrev) || null,
        scorer: nameOf(num(g?.playerId), g?.firstName, g?.lastName),
        power_play: String(g?.strength || "").toLowerCase() === "pp",
        score_after: { away: num(g?.awayScore), home: num(g?.homeScore) },
      });
    }
  }
  const away = text(landing?.awayTeam?.abbrev) || null;
  const home = text(landing?.homeTeam?.abbrev) || null;
  const pen = { [away]: { count: 0, minutes: 0 }, [home]: { count: 0, minutes: 0 } };
  for (const block of landing?.summary?.penalties || []) {
    for (const p of block?.penalties || []) {
      const tri = text(p?.teamAbbrev);
      if (!pen[tri]) continue;
      pen[tri].count += 1;
      pen[tri].minutes += num(p?.duration) || 0;
    }
  }
  return {
    goals,
    last_goal: goals.length ? goals[goals.length - 1] : null,
    shots: { away: num(landing?.awayTeam?.sog), home: num(landing?.homeTeam?.sog) },
    penalties: { away: pen[away] || { count: 0, minutes: 0 }, home: pen[home] || { count: 0, minutes: 0 } },
    power_play_goals: { away: goals.filter((g) => g.power_play && g.team === away).length, home: goals.filter((g) => g.power_play && g.team === home).length },
  };
}

// ---- «На что поставить сейчас» -----------------------------------------------------------------------------------------------
// rows: the live markets of the game (active, fresh). The next goal is the market of goal number (goals so far + 1); the total is
// the nearest line above the goals so far.
export function liveOffers(rows, { away, home, goals = 0 } = {}) {
  const list = rows || [];
  const pick = (type, test) => list.find((m) => m.market_type === type && test(m) && Number(m.odds) > 1);
  const out = [];
  const nextGoal = `nextgoalx:${Math.max(0, Math.floor(Number(goals) || 0)) + 1}`;
  for (const tri of [away, home]) {
    const m = pick(nextGoal, (x) => x.subject_key === tri);
    if (m) out.push({ kind: "next_goal", team: tri, label: `Следующий гол — ${tri}`, odds: Number(m.odds) });
  }
  for (const tri of [away, home]) {
    const m = pick("moneyline", (x) => x.subject_key === tri);
    if (m) out.push({ kind: "winner", team: tri, label: `Победа ${tri}`, odds: Number(m.odds) });
  }
  const totals = list
    .filter((m) => /^asiantotal:\d+(\.\d+)?$/.test(m.market_type) && String(m.outcome_name).toLowerCase() === "over" && Number(m.odds) > 1)
    .map((m) => ({ line: Number(m.market_type.split(":")[1]), odds: Number(m.odds) }))
    .filter((m) => m.line > (Number(goals) || 0))
    .sort((a, b) => a.line - b.line);
  if (totals.length) out.push({ kind: "total", label: `Тотал больше ${String(totals[0].line).replace(".", ",")}`, odds: totals[0].odds });
  return out;
}

// ---- the hook: the form of the teams -------------------------------------------------------------------------------------------
// results: the finished games of a team, the newest first, as "W"/"L" (an overtime or shootout loss is a loss here).
export function streakOf(results) {
  const list = results || [];
  if (!list.length) return null;
  const kind = list[0];
  let n = 0;
  for (const r of list) {
    if (r !== kind) break;
    n++;
  }
  return { kind, n };
}
const word = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
// the longest run of the two teams from 3 games («Юта: 4 победы подряд»): a win run first when they are equal
export function hookOf(forms, names = {}) {
  const best = (forms || []).filter((f) => f && f.streak && f.streak.n >= 3).sort((a, b) => b.streak.n - a.streak.n || (a.streak.kind === "W" ? -1 : 1))[0];
  if (!best) return null;
  const who = names[best.tri] || best.tri;
  const n = best.streak.n;
  // without a verb: «Даллас выиграла» / «Колорадо выиграл» — the gender of a city is not the gender of the team
  return best.streak.kind === "W" ? `${who}: ${n} ${word(n, "победа", "победы", "побед")} подряд` : `${who}: ${n} ${word(n, "поражение", "поражения", "поражений")} подряд`;
}

async function teamResults(db, tri, beforeIso) {
  const r = await db.prepare(`
    SELECT home_tri,away_tri,home_score,away_score FROM games
    WHERE game_type IN (2,3) AND game_state IN ('FINAL','OFF') AND (home_tri=? OR away_tri=?) AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC LIMIT 12;
  `).bind(tri, tri, beforeIso).all();
  return (r.results || []).map((g) => {
    const mine = g.home_tri === tri ? Number(g.home_score) : Number(g.away_score);
    const theirs = g.home_tri === tri ? Number(g.away_score) : Number(g.home_score);
    return mine > theirs ? "W" : "L";
  });
}

async function liveRows(db, gamePk, now) {
  const since = new Date(now - FRESH_SECONDS * 1000).toISOString().replace("T", " ").slice(0, 19);
  const r = await db.prepare(`
    SELECT m.market_type,m.subject_key,m.outcome_name,m.odds,m.updated_at
    FROM winline_events we JOIN winline_markets m ON m.winline_event_id=we.winline_event_id
    WHERE we.game_pk=? AND m.is_live=1 AND m.active=1 AND m.odds>1 AND m.updated_at>=?
      AND (m.market_type='moneyline' OR m.market_type LIKE 'nextgoalx:%' OR m.market_type LIKE 'asiantotal:%')
    ORDER BY m.updated_at DESC;
  `).bind(gamePk, since).all().catch(() => ({ results: [] }));
  return r.results || [];
}

export async function loadLivePayload(env, gamePk, { now = Date.now(), fetcher = fetchJson } = {}) {
  let landing;
  try { landing = await fetcher(NHL_LANDING(gamePk), { ttl: 8, timeoutMs: 6000 }); } catch { return { ok: false, error: "nhl_unavailable", status: 502 }; }
  const state = stateInfo(landing);
  const away = text(landing?.awayTeam?.abbrev) || null;
  const home = text(landing?.homeTeam?.abbrev) || null;
  const score = { away: num(landing?.awayTeam?.score), home: num(landing?.homeTeam?.score) };
  const out = { ok: true, game_pk: gamePk, live: state.phase === "live", phase: state.phase, label: state.label_ru, teams: { away, home }, score, recap: null, offers: [], hook: null };
  if (state.phase === "upcoming" || state.phase === "postponed") return out;
  let names = null;
  if (env?.DB) {
    try { names = await loadNames(env.DB, playerIdsOf(landing)); } catch { names = null; }
  }
  out.recap = recapOf(landing, names);
  if (out.live && env?.DB) {
    const goals = (Number(score.away) || 0) + (Number(score.home) || 0);
    out.offers = liveOffers(await liveRows(env.DB, gamePk, now), { away, home, goals });
    const start = String(landing?.startTimeUTC || new Date(now).toISOString());
    const [fa, fh, teams] = await Promise.all([
      teamResults(env.DB, away, start).catch(() => []),
      teamResults(env.DB, home, start).catch(() => []),
      env.DB.prepare(`SELECT tri_code,name_ru FROM teams WHERE tri_code IN (?,?);`).bind(away, home).all().catch(() => ({ results: [] })),
    ]);
    // «Юта Маммот» → «Юта»: the city is enough in a hook
    const ru = Object.fromEntries((teams.results || []).filter((t) => t.name_ru).map((t) => [t.tri_code, String(t.name_ru).split(" ")[0]]));
    out.hook = hookOf([{ tri: away, streak: streakOf(fa) }, { tri: home, streak: streakOf(fh) }], ru);
  }
  return out;
}

function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV32(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${liveApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  const m = API.exec(path);
  if (!m) return null;
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  const pk = Number(m[1]);
  // the same answer for everybody for 15 seconds: one look at the NHL and D1 per game, not one per fan
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request(`https://cache.hoh/v32/live/${pk}`);
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const payload = await loadLivePayload(env, pk);
  if (payload.ok === false) return json(payload, payload.status || 502);
  if (cache) await cache.put(key, new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => {});
  return json(payload);
}
