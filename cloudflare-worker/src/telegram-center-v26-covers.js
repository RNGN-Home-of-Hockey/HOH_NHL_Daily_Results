// Mini covers of our VK broadcasts, kept on the clip server (640 px, about 50 KB instead of the 1.5 MB original from VK).
// The server publishes /covers.json = {"version":1,"covers":{"<game_pk>":<picture version>}}; this module turns it into
// ready-to-use addresses. Any failure (server down, bad file) simply means "no mini cover": the app falls back to VK.
import { DEFAULT_CLIPS_BASE } from "./telegram-center-v26-goals-data.js";

export function clipsBaseOf(env) {
  return String(env?.HOH_CLIPS_BASE || "").trim().replace(/\/+$/, "") || DEFAULT_CLIPS_BASE;
}

export function coverUrlsFrom(doc, base) {
  const out = {};
  const covers = doc && typeof doc === "object" ? doc.covers : null;
  if (!covers || typeof covers !== "object") return out;
  for (const [pk, version] of Object.entries(covers)) {
    if (!/^\d{1,12}$/.test(pk)) continue;
    const v = Number(version);
    out[pk] = `${base}/covers/${pk}.jpg?v=${Number.isFinite(v) ? Math.trunc(v) : 0}`;
  }
  return out;
}

export async function loadCoverUrls(env) {
  const base = clipsBaseOf(env);
  try {
    const res = await fetch(`${base}/covers.json`, {
      headers: { accept: "application/json", "user-agent": "HOH-Live-Center/26" },
      cf: { cacheTtl: 30, cacheEverything: true },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return {};
    return coverUrlsFrom(await res.json(), base);
  } catch (error) {
    return {};
  }
}
