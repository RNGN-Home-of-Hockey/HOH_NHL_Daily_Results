// Live Center v33: the fan himself (package 2 of the owner's list, 2026-10-15).
//   - the first visit: «За кого болеете?» — the favourite team, its best players, what the person likes; the answers become the
//     usual follows, so the home page puts the games, goals and news of the team first by itself;
//   - the achievements: days in a row in the app, broadcasts and fresh news opened, picks, exact scores, streaks, brave picks,
//     follows — the first step of each is easy (the owner: «первые ступени лёгкие, чтобы их было приятно закрывать»).
//   GET  /api/telegram-center-v33/onboarding          the 32 teams
//   GET  /api/telegram-center-v33/teams/<TRI>/stars   the best players of a team this season (points)
//   GET  /api/telegram-center-v33/me                  onboarded?, follows, interests, achievements
//   PUT  /api/telegram-center-v33/me                  {interests:[...], onboarded:true}
//   POST /api/telegram-center-v33/activity            {kind:"open"|"stream"|"news", news_id?}
import { fanApp } from "./telegram-center-v33-fan-ui.js";
import { telegramAuth, upsertTelegramUser } from "./telegram-center-v29-predictions.js";
import { streakAfter, UNDERDOG_MIN_ODDS } from "./telegram-center-v29-predictions-data.js";

export const SCRIPT_PATH = "/telegram-app/v33-fan.js";
const API = "/api/telegram-center-v33";
const STARS = /^\/api\/telegram-center-v33\/teams\/([A-Z]{3})\/stars$/;
export const INTERESTS = ["results", "streams", "bets"];
export const FRESH_NEWS_HOURS = 48;
const STAR_LIMIT = 12;

// the achievements: the value of each and its steps
export const ACHIEVEMENTS = [
  { key: "days", icon: "📅", title: "Каждый день с хоккеем", steps: [3, 7, 14, 30], hint: "дней подряд в приложении" },
  { key: "streams", icon: "📺", title: "Зритель", steps: [1, 5, 10, 25], hint: "трансляций открыто из приложения" },
  { key: "news", icon: "📰", title: "В курсе событий", steps: [3, 10, 30, 100], hint: "свежих новостей прочитано" },
  { key: "picks", icon: "🗳", title: "Прогнозист", steps: [1, 10, 50, 100], hint: "прогнозов на матчи" },
  { key: "exact", icon: "🎯", title: "Снайпер", steps: [1, 3, 10], hint: "угаданных точных счетов" },
  { key: "streak", icon: "🔥", title: "Серия", steps: [3, 5, 10, 15], hint: "лучшая серия угаданных подряд" },
  { key: "brave", icon: "💪", title: "Смелый прогноз", steps: [1, 3, 10], hint: "угаданных побед андердога (кэф от 2.10)" },
  { key: "follows", icon: "❤️", title: "Свой в команде", steps: [1, 5, 10], hint: "команд и игроков в подписках" },
];

// the step reached and the next target: {tier: how many steps are done, next: the next target or null}
export function tierOf(value, steps) {
  const v = Math.max(0, Math.floor(Number(value) || 0));
  let tier = 0;
  for (const s of steps) if (v >= s) tier++;
  return { tier, next: tier < steps.length ? steps[tier] : null };
}

export function achievementsOf(values) {
  return ACHIEVEMENTS.map((a) => {
    const value = Math.max(0, Math.floor(Number(values?.[a.key]) || 0));
    const t = tierOf(value, a.steps);
    return { key: a.key, icon: a.icon, title: a.title, hint: a.hint, value, tier: t.tier, tiers: a.steps.length, next: t.next, steps: a.steps };
  });
}

// the days in a row with the app opened, up to today or yesterday (a streak is not lost before the day is over)
export function daysInRow(days, today) {
  const set = new Set(days || []);
  const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  let day = set.has(today) ? today : shift(today, -1);
  let n = 0;
  while (set.has(day)) {
    n++;
    day = shift(day, -1);
  }
  return n;
}

export function moscowDate(nowMs) {
  return new Date(nowMs + 3 * 3600000).toISOString().slice(0, 10);
}

export function cleanInterests(list) {
  if (!Array.isArray(list)) return null;
  return [...new Set(list.map((x) => String(x)).filter((x) => INTERESTS.includes(x)))];
}

// ---- the values of the achievements ------------------------------------------------------------------------------------------
async function valuesOf(db, id, now) {
  const [act, picks, follows] = await Promise.all([
    db.prepare(`SELECT day,opens,streams,news FROM fan_activity WHERE telegram_user_id=? ORDER BY day DESC LIMIT 400;`).bind(id).all(),
    db.prepare(`
      SELECT p.result,p.exact,p.odds_at_pick FROM fan_predictions p JOIN games g ON g.game_pk=p.game_pk
      WHERE p.telegram_user_id=? ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
    `).bind(id).all(),
    db.prepare(`SELECT COUNT(*) n FROM subscriptions WHERE telegram_user_id=? AND subject_type IN ('team','player');`).bind(id).first(),
  ]);
  const rows = act.results || [];
  let current = 0, best = 0, exact = 0, brave = 0;
  for (const p of picks.results || []) {
    if (p.result === "win" || p.result === "loss") {
      current = streakAfter(current, p.result === "win");
      best = Math.max(best, current);
    }
    if (Number(p.exact) === 1) exact++;
    if (p.result === "win" && Number(p.odds_at_pick) >= UNDERDOG_MIN_ODDS) brave++;
  }
  return {
    days: daysInRow(rows.filter((r) => Number(r.opens) > 0).map((r) => r.day), moscowDate(now)),
    streams: rows.reduce((s, r) => s + (Number(r.streams) || 0), 0),
    news: rows.reduce((s, r) => s + (Number(r.news) || 0), 0),
    picks: (picks.results || []).length,
    exact,
    streak: best,
    brave,
    follows: Number(follows?.n) || 0,
  };
}

// ---- the routes ----------------------------------------------------------------------------------------------------------------
async function onboarding(env) {
  const r = await env.DB.prepare(`SELECT tri_code,name_ru,name_en,logo_url FROM teams WHERE active=1 ORDER BY COALESCE(name_ru,name_en);`).all();
  return json({ ok: true, teams: (r.results || []).map((t) => ({ tri: t.tri_code, name_ru: t.name_ru || t.name_en, logo: t.logo_url || `https://assets.nhle.com/logos/nhl/svg/${t.tri_code}_light.svg` })) }, 200, "public, max-age=3600");
}

export function seasonNow(nowMs = Date.now()) {
  const d = new Date(nowMs), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return m >= 9 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

async function stars(env, tri, now) {
  const season = seasonNow(now);
  const r = await env.DB.prepare(`
    SELECT p.player_id,COALESCE(p.full_name_ru,p.full_name_en) name,p.position_code,
           SUM(s.goals) goals,SUM(s.points) points,COUNT(*) games
    FROM players p JOIN player_game_stats s ON s.player_id=p.player_id JOIN games g ON g.game_pk=s.game_pk
    WHERE p.current_team_tri=? AND g.season_id=? AND g.game_type IN (2,3)
    GROUP BY p.player_id ORDER BY points DESC,goals DESC,games DESC,p.player_id ASC LIMIT ?;
  `).bind(tri, season, STAR_LIMIT).all();
  return json({
    ok: true, tri, season,
    players: (r.results || []).map((x) => ({
      player_id: Number(x.player_id), name: x.name, position: x.position_code, goals: Number(x.goals) || 0, points: Number(x.points) || 0, games: Number(x.games) || 0,
      photo: `https://assets.nhle.com/mugs/nhl/${season}/${tri}/${x.player_id}.png`,
    })),
  }, 200, "public, max-age=600");
}

async function getMe(request, env, now) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const id = auth.user.id;
  const prof = await env.DB.prepare(`SELECT interests,onboarded_at FROM fan_profiles WHERE telegram_user_id=? LIMIT 1;`).bind(id).first();
  let interests = [];
  try { interests = cleanInterests(JSON.parse(prof?.interests || "[]")) || []; } catch { interests = []; }
  const values = await valuesOf(env.DB, id, now);
  return json({ ok: true, onboarded: Boolean(prof?.onboarded_at), follows: values.follows, interests, achievements: achievementsOf(values) });
}

async function putMe(request, env) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const interests = body?.interests === undefined ? undefined : cleanInterests(body.interests);
  if (interests === null) return json({ ok: false, error: "invalid_interests" }, 400);
  if (interests === undefined && body?.onboarded !== true) return json({ ok: false, error: "invalid_settings" }, 400);
  await upsertTelegramUser(env.DB, auth.user);
  const value = interests === undefined ? null : JSON.stringify(interests);
  const done = body?.onboarded === true ? 1 : 0;
  await env.DB.prepare(`
    INSERT INTO fan_profiles(telegram_user_id,interests,onboarded_at,updated_at) VALUES(?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP END,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET interests=COALESCE(?,fan_profiles.interests),
      onboarded_at=CASE WHEN ?=1 THEN COALESCE(fan_profiles.onboarded_at,CURRENT_TIMESTAMP) ELSE fan_profiles.onboarded_at END,updated_at=CURRENT_TIMESTAMP;
  `).bind(auth.user.id, value, done, value, done).run();
  return json({ ok: true, ...(interests === undefined ? {} : { interests }) });
}

async function activity(request, env, now) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const kind = String(body?.kind || "");
  if (!["open", "stream", "news"].includes(kind)) return json({ ok: false, error: "invalid_kind" }, 400);
  if (kind === "news") {
    // only fresh news count (the owner: «только свежие берём, не берём старые»)
    const id = Number(body?.news_id);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ ok: false, error: "invalid_news" }, 400);
    const n = await env.DB.prepare(`SELECT published_at,created_at FROM sports_news WHERE news_id=? LIMIT 1;`).bind(id).first();
    const raw = String(n?.published_at || n?.created_at || "").replace(" ", "T");
    const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
    if (!Number.isFinite(at) || now - at > FRESH_NEWS_HOURS * 3600000) return json({ ok: true, counted: false });
  }
  await upsertTelegramUser(env.DB, auth.user);
  const day = moscowDate(now);
  // an open counts once a day; a stream or a news every time
  await env.DB.prepare(`
    INSERT INTO fan_activity(telegram_user_id,day,opens,streams,news,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id,day) DO UPDATE SET opens=MIN(1,fan_activity.opens+excluded.opens),streams=fan_activity.streams+excluded.streams,
      news=fan_activity.news+excluded.news,updated_at=CURRENT_TIMESTAMP;
  `).bind(auth.user.id, day, kind === "open" ? 1 : 0, kind === "stream" ? 1 : 0, kind === "news" ? 1 : 0).run();
  return json({ ok: true, counted: true, day });
}

function json(payload, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}

export async function handleTelegramCenterV33(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    const body = `(function(){const __name=(target,value)=>target;(${fanApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  if (path !== API && !path.startsWith(`${API}/`)) return null;
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const now = Date.now();
  const route = `${request.method} ${path}`;
  try {
    if (route === `GET ${API}/onboarding`) return await onboarding(env);
    const st = STARS.exec(path);
    if (st && request.method === "GET") return await stars(env, st[1], now);
    if (route === `GET ${API}/me`) return await getMe(request, env, now);
    if (route === `PUT ${API}/me`) return await putMe(request, env);
    if (route === `POST ${API}/activity`) return await activity(request, env, now);
  } catch (error) {
    console.error("v33 fan failed", route, error);
    return json({ ok: false, error: "fan_failed" }, 503);
  }
  const known = ["/onboarding", "/me", "/activity"].some((p) => path === API + p) || STARS.test(path);
  return json({ ok: false, error: known ? "method_not_allowed" : "not_found" }, known ? 405 : 404);
}
