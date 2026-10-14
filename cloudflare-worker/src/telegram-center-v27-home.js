// Live Center v27: the home page. One answer for the whole first screen (score strip, match of the day, goal clips) and the script
// that draws it. News and the YouTube videos keep their own endpoints.
import { stateInfo, phaseOf, DEFAULT_CLIPS_BASE } from "./telegram-center-v26-goals-data.js";
import { loadNames, fetchJson, seasonIdOf } from "./telegram-center-v26-goals.js";
import { handleTelegramCenterV19ProductData } from "./telegram-center-v19-product-data.js";
import { homeScreenApp } from "./telegram-center-v27-home-ui.js";
import { gameFromRow, buildHomePayload, applyNames, applyGoalCounts, applyHeroLive, stripOf } from "./telegram-center-v27-home-data.js";
import { buildRussians } from "./telegram-center-v27-russians.js";

export const HOME_PATH = "/api/telegram-center-v27/home";
export const SCRIPT_PATH = "/telegram-app/v27-home.js";
const FEATURED_PATH = "/api/telegram-center-v19/featured";
const NHL_LANDING = (gamePk) => `https://api-web.nhle.com/v1/gamecenter/${gamePk}/landing`;
const NHL_BOX = (gamePk) => `https://api-web.nhle.com/v1/gamecenter/${gamePk}/boxscore`;
const EDGE_CACHE_SECONDS = 10;
const BEHIND_MS = 40 * 3600 * 1000;
const AHEAD_MS = 72 * 3600 * 1000;

function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
  });
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function loadGames(db, now) {
  const rows = await db.prepare(`
    SELECT date(datetime(g.scheduled_start_utc,'-8 hours')) calendar_date,
           g.game_pk,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,
           ht.name_en home_name_en,ht.name_ru home_name_ru,ht.logo_url home_logo,
           at.name_en away_name_en,at.name_ru away_name_ru,at.logo_url away_logo,
           vb.web_url vk_url,vb.app_url vk_app_url
    FROM games g
    LEFT JOIN teams ht ON ht.tri_code=g.home_tri
    LEFT JOIN teams at ON at.tri_code=g.away_tri
    LEFT JOIN game_vk_broadcasts gvb ON gvb.game_pk=g.game_pk
    LEFT JOIN vk_broadcasts vb ON vb.source_key=gvb.source_key
    WHERE g.scheduled_start_utc>=? AND g.scheduled_start_utc<? AND g.game_type IN (1,2,3)
    ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
  `).bind(iso(now - BEHIND_MS), iso(now + AHEAD_MS)).all();
  return (rows.results || []).map(gameFromRow);
}

// The match of the day is chosen by the existing featured endpoint (strength of the teams, playoffs, manual overrides, Winline line).
async function loadFeatured(env, day) {
  const response = await handleTelegramCenterV19ProductData(new Request(`https://home.invalid${FEATURED_PATH}?date=${day}&focus=now`), env, FEATURED_PATH);
  if (!response || !response.ok) return null;
  const body = await response.json();
  return body && body.featured ? body.featured : null;
}

async function loadHeroLive(featured) {
  const landing = await fetchJson(NHL_LANDING(featured.game_pk), { ttl: 8, timeoutMs: 5000 });
  const info = stateInfo(landing);
  const away = Number(landing?.awayTeam?.score);
  const home = Number(landing?.homeTeam?.score);
  return {
    code: info.code,
    label: info.phase === "live" ? info.label_ru : "",
    away_score: Number.isFinite(away) ? away : null,
    home_score: Number.isFinite(home) ? home : null,
  };
}

// Russians who play on the day of the strip. Box scores of games that are on (10 s) or finished (1 h) say how they played.
async function loadRussians(env, dayGames, now) {
  const tris = [...new Set(dayGames.flatMap((g) => [g.away.tri, g.home.tri]).filter(Boolean))];
  if (!tris.length) return [];
  const marks = tris.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT p.player_id,COALESCE(m.full_name_ru,p.full_name_ru) full_name_ru,p.full_name_en,p.current_team_tri,p.position_code,p.sweater_number
    FROM players p JOIN player_profile_meta m ON m.player_id=p.player_id
    WHERE m.primary_country_code='RUS' AND COALESCE(p.active,1)=1 AND p.current_team_tri IN (${marks});
  `).bind(...tris).all();
  const players = rows.results || [];
  if (!players.length) return [];
  const withRussians = new Set(players.map((p) => String(p.current_team_tri).toUpperCase()));
  const boxes = new Map();
  await Promise.allSettled(dayGames
    .filter((g) => (g.phase === "live" || g.phase === "final") && (withRussians.has(g.away.tri) || withRussians.has(g.home.tri)))
    .map(async (g) => { boxes.set(g.game_pk, await fetchJson(NHL_BOX(g.game_pk), { ttl: g.phase === "live" ? 10 : 3600, timeoutMs: 5000 })); }));
  return buildRussians({ games: dayGames, players, boxes, season: seasonIdOf(now) });
}

// Ids of all Russian players of the league: their goals go first on the shelf.
async function loadRussianIds(env) {
  const rows = await env.DB.prepare("SELECT player_id FROM player_profile_meta WHERE primary_country_code='RUS';").all();
  return new Set((rows.results || []).map((r) => Number(r.player_id)).filter(Boolean));
}

// "How many goals in the season" of the Russian scorers: the landing feed of each game says it for every goal (goalsToDate).
async function loadGoalCounts(tiles) {
  const counts = new Map();
  const games = [...new Map(tiles.map((t) => [t.game_pk, t.live])).entries()];
  await Promise.allSettled(games.map(async ([gamePk, live]) => {
    const landing = await fetchJson(NHL_LANDING(gamePk), { ttl: live ? 10 : 3600, timeoutMs: 5000 });
    for (const period of landing?.summary?.scoring || []) {
      for (const goal of period?.goals || []) {
        const n = Number(goal?.goalsToDate);
        if (goal?.eventId != null && Number.isFinite(n)) counts.set(`${gamePk}:${Number(goal.eventId)}`, n);
      }
    }
  }));
  return counts;
}

// The clip index of the highlights server. When the server is slow (it answered in more than 4 s now and then) the shelf of goals
// used to vanish from the home page; now it waits up to 8 s and, failing that, uses the last good index of this worker
// (up to 30 minutes old: the goals of the night do not change any more).
const indexMemory = new Map();
export async function loadClipIndex(base, { fetcher = fetchJson, now = Date.now() } = {}) {
  const url = `${String(base).replace(/\/+$/, "")}/index.json`;
  try {
    const fresh = await fetcher(url, { ttl: 20, timeoutMs: 8000 });
    if (fresh && Array.isArray(fresh.games)) indexMemory.set(url, { at: now, data: fresh });
    return fresh;
  } catch (error) {
    const kept = indexMemory.get(url);
    if (kept && now - kept.at <= 30 * 60 * 1000) return kept.data;
    throw error;
  }
}

const realDeps = {
  loadRussians,
  loadRussianIds,
  loadGoalCounts,
  loadGames: (env, now) => loadGames(env.DB, now),
  loadFeatured,
  loadIndex: (base) => loadClipIndex(base),
  loadNames: (env, ids) => loadNames(env.DB, ids),
  loadHeroLive,
};

// `deps` lets the tests (and the local audit proxy) answer the five questions without D1, NHL and the clip server.
export async function loadHomePayload(env, { now = Date.now(), deps = realDeps } = {}) {
  if (!env?.DB && deps === realDeps) return { ok: false, error: "missing_d1_binding", status: 503 };
  const base = (String(env?.HOH_CLIPS_BASE || "").trim() || DEFAULT_CLIPS_BASE).replace(/\/+$/, "");
  const games = await deps.loadGames(env, now);
  // the first pass only decides the mood of the page and the day of the match of the day
  const first = buildHomePayload({ games, now });

  const [featuredResult, indexResult, russiansResult, idsResult] = await Promise.allSettled([
    first.hero_day ? deps.loadFeatured(env, first.hero_day) : Promise.resolve(null),
    deps.loadIndex(base),
    first.strip_day && deps.loadRussians ? deps.loadRussians(env, stripOf(games, first.strip_day), now) : Promise.resolve([]),
    deps.loadRussianIds ? deps.loadRussianIds(env) : Promise.resolve(null),
  ]);
  if (idsResult.status === "rejected") console.error("v27 russian ids failed", idsResult.reason);
  if (russiansResult.status === "rejected") console.error("v27 russians failed", russiansResult.reason);
  const featured = featuredResult.status === "fulfilled" ? featuredResult.value : null;
  if (featuredResult.status === "rejected") console.error("v27 featured failed", featuredResult.reason);
  const index = indexResult.status === "fulfilled" ? indexResult.value : null;
  const payload = buildHomePayload({
    games, now, featured, index, indexOk: Boolean(index && Array.isArray(index.games)), clipsBase: base,
    russianIds: idsResult.status === "fulfilled" ? idsResult.value : null,
  });

  payload.russians = { ok: russiansResult.status === "fulfilled", day: first.strip_day, items: russiansResult.status === "fulfilled" ? russiansResult.value : [] };

  const ids = [...new Set(payload.goals.items.map((t) => t.scorer_id).filter(Boolean))];
  if (ids.length) {
    try { applyNames(payload.goals, await deps.loadNames(env, ids)); } catch (error) { console.error("v27 names failed", error); }
  }
  const russianTiles = payload.goals.items.filter((t) => t.russian);
  if (russianTiles.length && deps.loadGoalCounts) {
    try { applyGoalCounts(payload.goals, await deps.loadGoalCounts(russianTiles)); } catch (error) { console.error("v27 goal counts failed", error); }
  }
  if (featured && phaseOf(featured.game_state) === "live") {
    try { applyHeroLive(payload, await deps.loadHeroLive(featured)); } catch (error) { console.error("v27 live label failed", error); }
  }
  return payload;
}

// All visitors share one answer for a few seconds.
async function cachedHome(request, env) {
  const cache = globalThis.caches && globalThis.caches.default;
  const now = Date.now();
  const key = cache ? new Request(`${new URL(request.url).origin}/__cache/v27-home?b=${Math.floor(now / (EDGE_CACHE_SECONDS * 1000))}`) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (error) { console.error("v27 cache read failed", error); }
  }
  const payload = await loadHomePayload(env, { now });
  if (payload.ok === false) return json({ ok: false, error: payload.error }, payload.status || 503);
  const response = json(payload, 200, `public, max-age=${EDGE_CACHE_SECONDS}`);
  if (cache) {
    try { await cache.put(key, response.clone()); } catch (error) { console.error("v27 cache write failed", error); }
  }
  return response;
}

export async function handleTelegramCenterV27(request, env, path) {
  if (path === HOME_PATH) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    try {
      return await cachedHome(request, env);
    } catch (error) {
      console.error("v27 home failed", error);
      return json({ ok: false, error: "home_failed" }, 500);
    }
  }
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    // wrapped in a function: the bundler adds a __name helper that must not collide with other layers
    const body = `(function(){const __name=(target,value)=>target;(${homeScreenApp.toString()})();})();`;
    return new Response(body, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" },
    });
  }
  return null;
}
