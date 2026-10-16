// HOH EPL operator site on Cloudflare (worker epl → https://epl.rngn.workers.dev, account rngn).
// Pages are the static files of epl-site/; data/site.json lives in KV and is replaced by the server
// pipeline (tools/epl_publish.py) with POST /api/ingest, authorised by the EPL_INGEST_KEY secret.
// GET /api/health tells when the data was last replaced. /api/onair/* (the on-air buttons and the OBS overlay) is
// forwarded to the on-air service on our Moscow server (ONAIR_ORIGIN), the single source of what is on air.

const DATA_KEY = 'site.json';
const META_KEY = 'meta';
const MAX_BYTES = 20 * 1024 * 1024;
const NO_INDEX = 'noindex, nofollow';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': NO_INDEX },
});

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function readBody(request) {
  let stream = request.body;
  if (!stream) return '';
  if ((request.headers.get('x-epl-encoding') || '').toLowerCase() === 'gzip') stream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) throw new Error('payload too large');
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

async function ingest(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(token.trim(), (env.EPL_INGEST_KEY || '').trim())) return json({ ok: false, error: 'unauthorized' }, 401);
  let text;
  let data;
  try {
    text = await readBody(request);
    data = JSON.parse(text);
  } catch (error) {
    return json({ ok: false, error: `bad payload: ${error.message}` }, 400);
  }
  if (!Array.isArray(data?.matches) || !data.generated_at) return json({ ok: false, error: 'not a site.json (matches, generated_at)' }, 422);
  const meta = {
    updated_at: new Date().toISOString(), bytes: text.length, generated_at: data.generated_at, winline_captured_at: data.winline_captured_at || null,
    matches: data.matches.length, cards: data.matches.reduce((sum, m) => sum + (m.insights?.length || 0), 0),
  };
  await env.EPL.put(DATA_KEY, text);
  await env.EPL.put(META_KEY, JSON.stringify(meta));
  return json({ ok: true, ...meta });
}

async function siteData(env) {
  const text = await env.EPL.get(DATA_KEY);
  if (!text) return json({ ok: false, error: 'no data yet' }, 404);
  return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': NO_INDEX } });
}

async function onair(request, env, url) {
  const origin = String(env.ONAIR_ORIGIN || '').replace(/\/$/, '');
  if (!origin) return json({ ok: false, error: 'onair_not_configured' }, 503);
  const headers = new Headers();
  for (const name of ['content-type', 'x-operator-key', 'authorization']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  try {
    const answer = await fetch(origin + url.pathname + url.search, { method: request.method, headers, body });
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-robots-tag': NO_INDEX } });
  } catch {
    return json({ ok: false, error: 'onair_unreachable' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/data/site.json') return siteData(env);
    if (pathname === '/api/ingest') return ingest(request, env);
    if (pathname.startsWith('/api/onair/')) return onair(request, env, new URL(request.url));
    if (pathname === '/api/health') return json({ ok: true, ...JSON.parse((await env.EPL.get(META_KEY)) || '{}') });
    if (pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const response = await env.ASSETS.fetch(request);
    const out = new Response(response.body, response);
    out.headers.set('x-robots-tag', NO_INDEX);
    return out;
  },
};
