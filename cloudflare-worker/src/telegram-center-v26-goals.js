// Live Center v26: goals of a game (with clips from the highlights server), the match-screen script,
// and the embedded Inter font that makes every device render the app the same way.
import { buildGoalsPayload, playerIdsOf, DEFAULT_CLIPS_BASE } from "./telegram-center-v26-goals-data.js";
import { goalsScreenApp } from "./telegram-center-v26-goals-ui.js";

const NHL_LANDING = (gamePk) => `https://api-web.nhle.com/v1/gamecenter/${gamePk}/landing`;
const GOALS_PATH = /^\/api\/telegram-center-v26\/games\/(\d{1,12})\/goals$/;
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

async function fetchJson(url, { ttl, timeoutMs }) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "HOH-Live-Center/26" },
    cf: { cacheTtl: ttl, cacheEverything: true },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

async function loadNames(db, ids) {
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
  const [landingResult, indexResult] = await Promise.allSettled([
    fetchJson(NHL_LANDING(gamePk), { ttl: 8, timeoutMs: 6000 }),
    fetchJson(`${base.replace(/\/+$/, "")}/index.json`, { ttl: 20, timeoutMs: 4000 }),
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
  });
}

export async function handleTelegramCenterV26(request, env, path) {
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
