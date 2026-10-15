// The clip index pushed by the highlights server (2026-10-15). The Moscow server can call Cloudflare, but some Cloudflare data
// centres cannot reach it (the requests that come in through Frankfurt waited 8 s for index.json and showed no goals at all;
// Stockholm was fine). So the server sends index.json and covers.json here every 30 s when they change, and the Worker keeps
// the last copy in D1: every data centre reads the same goals. Only the server's own address may push; the files are public.
//   POST /api/telegram-center-v26/clip-index   {index:{version,games,...}, covers:{version,covers}}   (gzip allowed)
export const PUSH_PATH = "/api/telegram-center-v26/clip-index";
export const PUSH_FRESH_MS = 10 * 60 * 1000; // an older copy means the server stopped pushing: the direct fetch is tried
const MEMORY_MS = 20 * 1000;
const MAX_BYTES = 1800 * 1024; // the D1 limit of a value is 2 MB
const KEY_INDEX = "clip_index_push_v1";
const KEY_COVERS = "clip_covers_push_v1";
const DEFAULT_IPS = "109.172.113.187";

const memory = new Map(); // key -> { at, value }

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function bodyText(request) {
  const gz = /gzip/i.test(String(request.headers.get("content-encoding") || ""));
  const stream = gz ? request.body.pipeThrough(new DecompressionStream("gzip")) : request.body;
  return new Response(stream).text();
}

export async function handleClipIndexPush(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const allowed = String(env.CLIP_PUSH_IPS || DEFAULT_IPS).split(",").map((x) => x.trim()).filter(Boolean);
  const ip = String(request.headers.get("cf-connecting-ip") || "").trim();
  if (!ip || !allowed.includes(ip)) return json({ ok: false, error: "forbidden" }, 403);
  let doc;
  try {
    const text = await bodyText(request);
    if (text.length > 2 * MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
    doc = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const index = doc?.index;
  const covers = doc?.covers;
  if (!index || !Array.isArray(index.games)) return json({ ok: false, error: "invalid_index" }, 400);
  const indexText = JSON.stringify(index);
  if (indexText.length > MAX_BYTES) return json({ ok: false, error: "index_too_large" }, 413);
  const coversText = covers && covers.covers && typeof covers.covers === "object" ? JSON.stringify(covers) : null;
  const put = (key, value) => env.DB.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(key, value);
  await env.DB.batch([put(KEY_INDEX, indexText), ...(coversText && coversText.length <= MAX_BYTES ? [put(KEY_COVERS, coversText)] : [])]);
  memory.clear();
  return json({ ok: true, games: index.games.length, covers: coversText ? Object.keys(covers.covers).length : null, bytes: indexText.length });
}

// "YYYY-MM-DD HH:MM:SS" of D1 is UTC
const metaTime = (v) => Date.parse(`${String(v || "").replace(" ", "T")}Z`);

async function pushed(env, key, now) {
  const hit = memory.get(key);
  if (hit && now - hit.at < MEMORY_MS) return hit.value;
  let value = null;
  try {
    const row = await env?.DB?.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(key).first();
    if (row && now - metaTime(row.updated_at) <= PUSH_FRESH_MS) value = JSON.parse(row.meta_value);
  } catch {
    value = null;
  }
  memory.set(key, { at: now, value });
  return value;
}

// the last pushed index when it is fresh, otherwise null (the caller fetches the server directly then)
export async function pushedIndex(env, { now = Date.now() } = {}) {
  const v = await pushed(env, KEY_INDEX, now);
  return v && Array.isArray(v.games) ? v : null;
}

export async function pushedCovers(env, { now = Date.now() } = {}) {
  const v = await pushed(env, KEY_COVERS, now);
  return v && v.covers && typeof v.covers === "object" ? v : null;
}

export function clearPushMemory() {
  memory.clear();
}
