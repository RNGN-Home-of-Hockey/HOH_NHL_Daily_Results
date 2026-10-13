// Live Center v27: the home page. One answer for the whole first screen (score strip, match of the day, goal clips) and the script
// that draws it. News and the YouTube videos keep their own endpoints.
import { stateInfo, phaseOf, DEFAULT_CLIPS_BASE } from "./telegram-center-v26-goals-data.js";
import { loadNames, fetchJson } from "./telegram-center-v26-goals.js";
import { handleTelegramCenterV19ProductData } from "./telegram-center-v19-product-data.js";
import { homeScreenApp } from "./telegram-center-v27-home-ui.js";
import { gameFromRow, buildHomePayload, applyNames, applyHeroLive } from "./telegram-center-v27-home-data.js";

export const HOME_PATH = "/api/telegram-center-v27/home";
export const SCRIPT_PATH = "/telegram-app/v27-home.js";
const FEATURED_PATH = "/api/telegram-center-v19/featured";
const NHL_LANDING = (gamePk) => `https://api-web.nhle.com/v1/gamecenter/${gamePk}/landing`;
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
           at.name_en away_name_en,at.name_ru away_name_ru,at.logo_url away_logo
    FROM games g
    LEFT JOIN teams ht ON ht.tri_code=g.home_tri
    LEFT JOIN teams at ON at.tri_code=g.away_tri
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

const realDeps = {
  loadGames: (env, now) => loadGames(env.DB, now),
  loadFeatured,
  loadIndex: (base) => fetchJson(`${base.replace(/\/+$/, "")}/index.json`, { ttl: 20, timeoutMs: 4000 }),
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

  const [featuredResult, indexResult] = await Promise.allSettled([
    first.hero_day ? deps.loadFeatured(env, first.hero_day) : Promise.resolve(null),
    deps.loadIndex(base),
  ]);
  const featured = featuredResult.status === "fulfilled" ? featuredResult.value : null;
  if (featuredResult.status === "rejected") console.error("v27 featured failed", featuredResult.reason);
  const index = indexResult.status === "fulfilled" ? indexResult.value : null;
  const payload = buildHomePayload({
    games, now, featured, index, indexOk: Boolean(index && Array.isArray(index.games)), clipsBase: base,
  });

  const ids = [...new Set(payload.goals.items.map((t) => t.scorer_id).filter(Boolean))];
  if (ids.length) {
    try { applyNames(payload.goals, await deps.loadNames(env, ids)); } catch (error) { console.error("v27 names failed", error); }
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
