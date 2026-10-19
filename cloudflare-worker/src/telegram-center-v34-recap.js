// Live Center v34: «Мои итоги» (package 3 of the owner's list, 2026-10-15) — the month or the season of a fan as a card that is
// worth a screenshot (the owner: «как в Spotify… чтобы люди хотели делиться»): picks, accuracy, the best guess, the favourite
// team, the best run, «точнее, чем X%». The app draws the card itself and uploads the picture; Telegram puts it into a story
// from the public address below.
//   GET  /api/telegram-center-v34/recap?period=month|season
//   POST /api/telegram-center-v34/cards?period=month|season   (the picture, image/png or image/jpeg, up to 1.5 MB)
//   GET  /api/telegram-center-v34/cards/<id>.png               (public, for Telegram)
import { recapApp } from "./telegram-center-v34-recap-ui.js";
import { telegramAuth, upsertTelegramUser, accuracyTable, betterOf } from "./telegram-center-v29-predictions.js";
import { levelOf, nhlDateOf, seasonOf, streakAfter, weekXpOf } from "./telegram-center-v29-predictions-data.js";

export const SCRIPT_PATH = "/telegram-app/v34-recap.js";
const API = "/api/telegram-center-v34";
const CARD = /^\/api\/telegram-center-v34\/cards\/([a-f0-9]{24})\.(png|jpg)$/;
export const MAX_CARD_BYTES = 1536 * 1024;
export const CARDS_PER_DAY = 20;
const KEEP_DAYS = 7;
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

export function periodOf(period, nowMs) {
  const today = nhlDateOf(new Date(nowMs).toISOString());
  const season = seasonOf(today);
  if (period === "season") return { period, season, label: `Сезон ${season.slice(0, 4)}/${season.slice(6, 8)}`, sql: "p.season_id=?", args: [season] };
  const from = `${today.slice(0, 7)}-01`;
  return { period: "month", season, label: `${MONTHS[Number(today.slice(5, 7)) - 1]} ${today.slice(0, 4)}`, sql: "p.game_date>=? AND p.game_date<=?", args: [from, `${today.slice(0, 7)}-31`] };
}

// rows: the picks of the person in the period, in the order of the games
export function recapOf(rows, teamNames = {}) {
  const list = rows || [];
  const played = list.filter((r) => r.result === "win" || r.result === "loss");
  const correct = played.filter((r) => r.result === "win");
  let run = 0, best = 0;
  for (const r of played) {
    run = streakAfter(run, r.result === "win");
    best = Math.max(best, run);
  }
  // the best guess: the right pick with the biggest odds at the moment of the pick
  const brave = correct.filter((r) => Number(r.odds_at_pick) > 1).sort((a, b) => Number(b.odds_at_pick) - Number(a.odds_at_pick))[0] || null;
  const count = new Map();
  for (const r of list) count.set(r.pick_tri, (count.get(r.pick_tri) || 0) + 1);
  const fav = [...count.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || null;
  return {
    picks: list.length,
    settled: played.length,
    correct: correct.length,
    accuracy: played.length ? Math.round((100 * correct.length) / played.length) : null,
    xp: list.reduce((s, r) => s + (Number(r.xp) || 0), 0),
    exact: list.filter((r) => Number(r.exact) === 1).length,
    best_streak: best,
    best_pick: brave ? { tri: brave.pick_tri, name: teamNames[brave.pick_tri] || brave.pick_tri, odds: Number(brave.odds_at_pick), game: `${brave.away_tri} — ${brave.home_tri}` } : null,
    favorite: fav ? { tri: fav[0], name: teamNames[fav[0]] || fav[0], picks: fav[1] } : null,
  };
}

async function recap(request, env, now) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const raw = String(new URL(request.url).searchParams.get("period") || "month");
  if (!["month", "season"].includes(raw)) return json({ ok: false, error: "invalid_period" }, 400);
  const p = periodOf(raw, now);
  const id = auth.user.id;
  const [rows, all, teams, table] = await Promise.all([
    env.DB.prepare(`
      SELECT p.pick_tri,p.result,p.xp,p.exact,p.odds_at_pick,g.home_tri,g.away_tri
      FROM fan_predictions p JOIN games g ON g.game_pk=p.game_pk
      WHERE p.telegram_user_id=? AND ${p.sql}
      ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
    `).bind(id, ...p.args).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(xp),0) xp FROM fan_predictions WHERE telegram_user_id=? AND settled_at IS NOT NULL;`).bind(id).first(),
    env.DB.prepare(`SELECT tri_code,name_ru FROM teams WHERE name_ru IS NOT NULL;`).all(),
    accuracyTable(env.DB, p.season),
  ]);
  const names = Object.fromEntries((teams.results || []).map((t) => [t.tri_code, t.name_ru]));
  const lv = levelOf((Number(all?.xp) || 0) + (await weekXpOf(env.DB, id)));
  return json({
    ok: true, period: p.period, label: p.label,
    recap: recapOf(rows.results || [], names),
    level: { n: lv.n, note: lv.note, xp: lv.xp },
    better_pct: betterOf(table, id),
  });
}

const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

async function upload(request, env) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const period = String(new URL(request.url).searchParams.get("period") || "month");
  if (!["month", "season"].includes(period)) return json({ ok: false, error: "invalid_period" }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_CARD_BYTES) return json({ ok: false, error: "invalid_size" }, 413);
  const png = isPng(bytes);
  if (!png && !isJpeg(bytes)) return json({ ok: false, error: "not_an_image" }, 415);
  const id = auth.user.id;
  const today = await env.DB.prepare(`SELECT COUNT(*) n FROM fan_share_cards WHERE telegram_user_id=? AND created_at>=datetime('now','-1 day');`).bind(id).first();
  if (Number(today?.n) >= CARDS_PER_DAY) return json({ ok: false, error: "too_many_cards" }, 429);
  await upsertTelegramUser(env.DB, auth.user);
  const cardId = hex(crypto.getRandomValues(new Uint8Array(12)));
  await env.DB.prepare(`DELETE FROM fan_share_cards WHERE created_at<datetime('now','-${KEEP_DAYS} days');`).run();
  await env.DB.prepare(`INSERT INTO fan_share_cards(card_id,telegram_user_id,period,mime,data) VALUES(?,?,?,?,?);`).bind(cardId, id, period, png ? "image/png" : "image/jpeg", bytes).run();
  const origin = new URL(request.url).origin;
  return json({ ok: true, url: `${origin}${API}/cards/${cardId}.${png ? "png" : "jpg"}` });
}

async function card(env, id) {
  const row = await env.DB.prepare(`SELECT mime,data FROM fan_share_cards WHERE card_id=? AND created_at>=datetime('now','-${KEEP_DAYS} days') LIMIT 1;`).bind(id).first();
  if (!row) return new Response("not_found", { status: 404 });
  const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data instanceof ArrayBuffer ? row.data : Array.from(row.data || []));
  return new Response(data, { headers: { "Content-Type": row.mime, "Cache-Control": "public, max-age=604800, immutable", "X-Content-Type-Options": "nosniff" } });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV34(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${recapApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  if (path !== API && !path.startsWith(`${API}/`)) return null;
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const now = Date.now();
  try {
    const c = CARD.exec(path);
    if (c && request.method === "GET") return await card(env, c[1]);
    if (path === `${API}/recap` && request.method === "GET") return await recap(request, env, now);
    if (path === `${API}/cards` && request.method === "POST") return await upload(request, env);
  } catch (error) {
    console.error("v34 recap failed", path, error);
    return json({ ok: false, error: "recap_failed" }, 503);
  }
  const known = path === `${API}/recap` || path === `${API}/cards` || CARD.test(path);
  return json({ ok: false, error: known ? "method_not_allowed" : "not_found" }, known ? 405 : 404);
}
