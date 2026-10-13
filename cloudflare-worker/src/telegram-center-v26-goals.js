// Live Center v26: goals of a game (with clips from the highlights server), the match-screen script,
// and the embedded Inter font that makes every device render the app the same way.
import { buildGoalsPayload, buildPlayerSeasonPayload, playerIdsOf, DEFAULT_CLIPS_BASE } from "./telegram-center-v26-goals-data.js";
import { goalsScreenApp } from "./telegram-center-v26-goals-ui.js";
import { loadCoverUrls } from "./telegram-center-v26-covers.js";

const NHL_LANDING = (gamePk) => `https://api-web.nhle.com/v1/gamecenter/${gamePk}/landing`;
const NHL_GAME_LOG = (playerId, season, type) => `https://api-web.nhle.com/v1/player/${playerId}/game-log/${season}/${type}`;
const COVERS_WANTED_PATH = "/api/telegram-center-v26/covers/wanted";
const PLAYER_GAMES_LIMIT = 45;
const GOALS_PATH = /^\/api\/telegram-center-v26\/games\/(\d{1,12})\/goals$/;
const PLAYER_GOALS_PATH = /^\/api\/telegram-center-v26\/players\/(\d{1,12})\/goals$/;
const FONT_PATH = /^\/telegram-app\/fonts\/(inter-(?:cyrillic-ext|cyrillic|latin-ext|latin)-wght-normal\.woff2)$/;
export const FONT_VERSION = "5.3.0";

const FONT_FACES = [
  ["cyrillic-ext", "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F"],
  ["cyrillic", "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"],
  ["latin-ext", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
  ["latin", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"],
];
const FAMILY = '"Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

// One font, loaded from our own server, for every element of the app. The wildcard rule is deliberate: the layers v9..v24
// name Arial/Impact/Inter in many places (and hard-code weights like 950); this keeps them all on the same file.
export const FONT_CSS =
  FONT_FACES.map(([name, range]) =>
    `@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:block;src:url(/telegram-app/fonts/inter-${name}-wght-normal.woff2?v=${FONT_VERSION}) format("woff2");unicode-range:${range}}`).join("\n") +
  `\nhtml{font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}` +
  `\n*,*::before,*::after{font-family:${FAMILY}!important;font-synthesis:none}\n`;

export const FONT_PRELOAD_LINKS = ["cyrillic", "latin"]
  .map((name) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="/telegram-app/fonts/inter-${name}-wght-normal.woff2?v=${FONT_VERSION}">`)
  .join("");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function fetchJson(url, { ttl, timeoutMs }) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "HOH-Live-Center/26" },
    cf: { cacheTtl: ttl, cacheEverything: true },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

export async function loadNames(db, ids) {
  const names = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const marks = chunk.map(() => "?").join(",");
    const result = await db.prepare(
      `SELECT player_id,full_name_ru FROM players WHERE player_id IN (${marks}) AND full_name_ru IS NOT NULL AND TRIM(full_name_ru)<>''`,
    ).bind(...chunk).all();
    for (const row of result?.results || []) names.set(Number(row.player_id), String(row.full_name_ru));
  }
  return names;
}

export async function loadGoalsPayload(env, gamePk, { now = Date.now() } = {}) {
  const base = String(env?.HOH_CLIPS_BASE || "").trim() || DEFAULT_CLIPS_BASE;
  const [landingResult, indexResult, coversResult] = await Promise.allSettled([
    fetchJson(NHL_LANDING(gamePk), { ttl: 8, timeoutMs: 6000 }),
    fetchJson(`${base.replace(/\/+$/, "")}/index.json`, { ttl: 20, timeoutMs: 4000 }),
    loadCoverUrls(env),
  ]);
  if (landingResult.status !== "fulfilled") return { ok: false, error: "nhl_unavailable", status: 502 };
  const landing = landingResult.value;
  let names = null;
  if (env?.DB) {
    try { names = await loadNames(env.DB, playerIdsOf(landing)); } catch (error) { console.error("v26 player names failed", error); }
  }
  const index = indexResult.status === "fulfilled" ? indexResult.value : null;
  return buildGoalsPayload({
    gamePk, landing, index, indexOk: Boolean(index && Array.isArray(index.games)), names, now, clipsBase: base,
    covers: coversResult.status === "fulfilled" ? coversResult.value : null,
  });
}

async function loadPlayerNames(db, playerId) {
  const row = await db.prepare("SELECT full_name_en,full_name_ru FROM players WHERE player_id=?").bind(playerId).first();
  return { nameEn: row?.full_name_en ? String(row.full_name_en) : null, nameRu: row?.full_name_ru ? String(row.full_name_ru) : null };
}

// NHL season id from a date: the 2026-27 season is "20262027"; from September on the new season counts.
export function seasonIdOf(now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 8 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

// Every goal of the player in the season (regular season and playoffs): the NHL game log says in which games he scored,
// the landing feed of each of those games says when and how. Finished games are cached for an hour, recent ones for seconds.
export async function loadPlayerGoalsPayload(env, playerId, { now = Date.now() } = {}) {
  const base = String(env?.HOH_CLIPS_BASE || "").trim() || DEFAULT_CLIPS_BASE;
  const season = seasonIdOf(now);
  const [regular, playoffs, indexResult, namesResult] = await Promise.allSettled([
    fetchJson(NHL_GAME_LOG(playerId, season, 2), { ttl: 60, timeoutMs: 6000 }),
    fetchJson(NHL_GAME_LOG(playerId, season, 3), { ttl: 60, timeoutMs: 6000 }),
    fetchJson(`${base.replace(/\/+$/, "")}/index.json`, { ttl: 20, timeoutMs: 4000 }),
    env?.DB ? loadPlayerNames(env.DB, playerId) : Promise.resolve({ nameEn: null, nameRu: null }),
  ]);
  if (regular.status !== "fulfilled") return { ok: false, error: "nhl_unavailable", status: 502 };
  if (namesResult.status === "rejected") console.error("v26 player names failed", namesResult.reason);
  const names = namesResult.status === "fulfilled" ? namesResult.value : { nameEn: null, nameRu: null };
  const index = indexResult.status === "fulfilled" ? indexResult.value : null;
  const log = [...(regular.value?.gameLog || []), ...(playoffs.status === "fulfilled" ? playoffs.value?.gameLog || [] : [])];
  const scoring = log
    .filter((r) => Number(r?.goals) > 0)
    .sort((a, b) => String(b.gameDate || "").localeCompare(String(a.gameDate || "")) || Number(b.gameId) - Number(a.gameId));
  const wanted = scoring.slice(0, PLAYER_GAMES_LIMIT);
  const landings = new Map();
  const recentFrom = new Date(now - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (let i = 0; i < wanted.length; i += 12) {
    const chunk = wanted.slice(i, i + 12);
    const results = await Promise.allSettled(chunk.map((r) =>
      fetchJson(NHL_LANDING(r.gameId), { ttl: String(r.gameDate || "") >= recentFrom ? 8 : 3600, timeoutMs: 6000 })));
    results.forEach((res, k) => { if (res.status === "fulfilled" && res.value) landings.set(Number(chunk[k].gameId), res.value); });
  }
  return buildPlayerSeasonPayload({
    playerId, names, season, log: wanted, landings, index, indexOk: Boolean(index && Array.isArray(index.games)),
    clipsBase: base, now, truncated: scoring.length > wanted.length,
  });
}

// The cover keeper on the highlights server asks which broadcasts have a cover worth saving.
// Without parameters: the games around today (4 days back, 2 ahead). With `since=YYYY-MM-DD` it walks the archive page by page,
// newest first: each answer carries `next` (a cursor "<start>|<game_pk>") to pass as `before` for the following page.
const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]{8,12}Z)\|(\d{6,12})$/;
const ARCHIVE_START = "2024-01-01";

export async function loadWantedCovers(env, { since = null, before = null, limit = 80, now = Date.now() } = {}) {
  if (!env?.DB) return { ok: false, error: "missing_d1_binding" };
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 80));
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  let lower;
  if (since !== null && since !== undefined && since !== "") {
    if (!SINCE_RE.test(String(since)) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) return { ok: false, error: "invalid_since", status: 400 };
    lower = `${String(since) < ARCHIVE_START ? ARCHIVE_START : since}T00:00:00Z`;
  } else {
    lower = iso(now - 4 * 24 * 3600 * 1000);
  }
  let upperStart = iso(now + 2 * 24 * 3600 * 1000);
  let upperPk = 999999999999;
  if (before !== null && before !== undefined && before !== "") {
    const m = CURSOR_RE.exec(String(before));
    if (!m) return { ok: false, error: "invalid_cursor", status: 400 };
    upperStart = m[1];
    upperPk = Number(m[2]);
  }
  const rows = await env.DB.prepare(`
    SELECT g.game_pk,g.game_state,g.scheduled_start_utc,b.source_key
    FROM games g
    JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
    JOIN vk_broadcasts b ON b.source_key=m.source_key
    WHERE b.thumbnail_url IS NOT NULL AND b.thumbnail_url<>''
      AND g.scheduled_start_utc>=?
      AND (g.scheduled_start_utc<? OR (g.scheduled_start_utc=? AND g.game_pk<?))
    ORDER BY g.scheduled_start_utc DESC,g.game_pk DESC LIMIT ?;
  `).bind(lower, upperStart, upperStart, upperPk, lim).all();
  const games = (rows.results || []).map((r) => ({
    game_pk: Number(r.game_pk), source_key: String(r.source_key), state: String(r.game_state || ""), start: String(r.scheduled_start_utc || ""),
  }));
  const last = games[games.length - 1];
  return { ok: true, games, next: games.length === lim && last ? `${last.start}|${last.game_pk}` : null };
}

export async function handleTelegramCenterV26(request, env, path) {
  const playerGoalsMatch = PLAYER_GOALS_PATH.exec(path);
  if (playerGoalsMatch) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    const playerId = Number(playerGoalsMatch[1]);
    if (!Number.isSafeInteger(playerId) || playerId <= 0) return json({ ok: false, error: "invalid_player_id" }, 400);
    try {
      const payload = await loadPlayerGoalsPayload(env, playerId);
      if (payload.ok === false) return json({ ok: false, error: payload.error }, payload.status || 502);
      return json(payload);
    } catch (error) {
      console.error("v26 player goals failed", error);
      return json({ ok: false, error: "player_goals_failed" }, 500);
    }
  }

  if (path === COVERS_WANTED_PATH) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    try {
      const params = new URL(request.url).searchParams;
      const wanted = await loadWantedCovers(env, { since: params.get("since"), before: params.get("before"), limit: params.get("limit") });
      return json(wanted, wanted.ok ? 200 : wanted.status || 503);
    } catch (error) {
      console.error("v26 wanted covers failed", error);
      return json({ ok: false, error: "covers_wanted_failed" }, 500);
    }
  }

  const goalsMatch = GOALS_PATH.exec(path);
  if (goalsMatch) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    const gamePk = Number(goalsMatch[1]);
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0) return json({ ok: false, error: "invalid_game_pk" }, 400);
    try {
      const payload = await loadGoalsPayload(env, gamePk);
      if (payload.ok === false) return json({ ok: false, error: payload.error }, payload.status || 502);
      return json(payload);
    } catch (error) {
      console.error("v26 goals failed", error);
      return json({ ok: false, error: "goals_failed" }, 500);
    }
  }

  if (path === "/telegram-app/v26-goals.js") {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    // wrapped in a function: the bundler adds a __name helper that must not collide with other layers
    const body = `(function(){const __name=(target,value)=>target;(${goalsScreenApp.toString()})();})();`;
    return new Response(body, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" },
    });
  }

  if (path === "/telegram-app/hoh-font.css") {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    return new Response(FONT_CSS, {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  }

  const fontMatch = FONT_PATH.exec(path);
  if (fontMatch) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    if (!env?.ASSETS?.fetch) return new Response("assets_binding_missing", { status: 503 });
    const asset = await env.ASSETS.fetch(request);
    if (!asset.ok) return asset;
    return new Response(asset.body, {
      status: 200,
      headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
    });
  }

  return null;
}
