// VK covers without the VK key. The public page of a video carries its picture in og:image (the tennis app takes its covers the
// same way). Streams linked to games of the next two days that have no picture yet get it from there: when the sync of the channel
// cannot log in to VK (14 October 2026: the key was refused all day) or VK has not put the picture into its API answer yet.
// VK answers the page to the Telegram link preview agent; other agents get the login page.
const UA = "TelegramBot (like TwitterBot)";
const STATE_KEY = "vk_cover_scrape_tried_v1";
const RETRY_MS = 15 * 60 * 1000; // one page at most every 15 minutes
const HOUR = 3600 * 1000;

export function ogImageOf(html) {
  const text = String(html || "");
  const m = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(text) || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i.exec(text);
  return m ? m[1].replace(/&amp;/g, "&").trim() : null;
}

// a real picture of a VK video, not the grey placeholder (/images/video/thumbs/video_l.png) nor the dead getVideoPreview link
export function isRealVkCover(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const vkHost = ["vkuserphoto.ru", "userapi.com", "vkuser.net", "vk-cdn.net", "vkusercontent.net"].some((root) => host === root || host.endsWith(`.${root}`));
  if (!vkHost) return false;
  if (/getVideoPreview/i.test(u.pathname + u.search)) return false;
  return /\/impg\//.test(u.pathname) || /type=video_thumb/i.test(u.search) || /\/s\/v1\/ig2\//.test(u.pathname);
}

export async function runVkCoverScrape(env, { now = Date.now(), limit = 6, fetcher = fetch } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "missing_d1_binding" };
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows = await db.prepare(`
    SELECT b.source_key,b.owner_id,b.video_id
    FROM game_vk_broadcasts m JOIN games g ON g.game_pk=m.game_pk JOIN vk_broadcasts b ON b.source_key=m.source_key
    WHERE g.scheduled_start_utc BETWEEN ? AND ?
      AND (b.thumbnail_url IS NULL OR b.thumbnail_url='' OR b.thumbnail_url LIKE '%/getVideoPreview?%')
    ORDER BY g.scheduled_start_utc ASC LIMIT 40;
  `).bind(iso(now - 12 * HOUR), iso(now + 48 * HOUR)).all();
  const stateRow = await db.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=?;`).bind(STATE_KEY).first().catch(() => null);
  let tried = {};
  try { tried = JSON.parse(stateRow?.meta_value || "{}") || {}; } catch { tried = {}; }
  const summary = { ok: true, candidates: (rows.results || []).length, fetched: 0, saved: 0, placeholder: 0, failed: 0 };
  let budget = limit;
  for (const r of rows.results || []) {
    if (budget <= 0) break;
    if (now - Number(tried[r.source_key] || 0) < RETRY_MS) continue;
    if (!r.owner_id || !r.video_id) continue;
    budget--;
    tried[r.source_key] = now;
    summary.fetched++;
    try {
      const res = await fetcher(`https://vk.com/video${r.owner_id}_${r.video_id}`, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (!res.ok) { summary.failed++; continue; }
      const image = ogImageOf(await res.text());
      if (!isRealVkCover(image)) { summary.placeholder++; continue; }
      await db.prepare(`UPDATE vk_broadcasts SET thumbnail_url=?,updated_at=CURRENT_TIMESTAMP
        WHERE source_key=? AND (thumbnail_url IS NULL OR thumbnail_url='' OR thumbnail_url LIKE '%/getVideoPreview?%');`).bind(image, r.source_key).run();
      summary.saved++;
    } catch (error) {
      summary.failed++;
    }
  }
  // keep the memory of the last day only
  for (const [k, t] of Object.entries(tried)) if (now - Number(t) > 24 * HOUR) delete tried[k];
  await db.prepare(`INSERT INTO data_core_meta(meta_key,meta_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;`).bind(STATE_KEY, JSON.stringify(tried)).run();
  return summary;
}
