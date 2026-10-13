// Live Center v29: the API of the game of the fans, the settlement of the finished games and the morning message of the bot.
//   GET  /api/telegram-center-v29/slate             the games of the next game day with an open vote (+ my picks, + last night)
//   GET  /api/telegram-center-v29/games?ids=1,2     the same blocks for chosen games (the match of the day, the match screen)
//   POST /api/telegram-center-v29/predictions       {game_pk, pick:"home"|"away"} — a pick, changeable until the start
//   GET  /api/telegram-center-v29/me                 my points, level, places in the table, last picks, settings
//   PUT  /api/telegram-center-v29/me                 {morning_digest:true|false}
//   GET  /api/telegram-center-v29/leaderboard?period=week|month|season
//   GET  /api/telegram-center-v29/status             counts only, for the checks
import { predictionsApp } from "./telegram-center-v29-predictions-ui.js";
import {
  GAME_TYPES, PERIODS, DIGEST_FROM_HOUR, DIGEST_TO_HOUR, DEFAULT_TIMEZONE,
  levelOf, nhlDateOf, addDays, dayStartUtc, isOpen, settleGame, periodRange, fanLabel, digestText, localParts,
} from "./telegram-center-v29-predictions-data.js";

const API = "/api/telegram-center-v29";
export const SCRIPT_PATH = "/telegram-app/v29-predict.js";
const MAX_IDS = 24;
const BOARD_LIMIT = 50;
const BOARD_CACHE_SECONDS = 60;
const DIGEST_BUDGET = 25;
const AVATAR_PATH = "/api/telegram-center-v22/avatars/";
const MINI_APP_URL = "https://hoh-nhl-daily-results.znamteam-903.workers.dev/telegram-app-v24";
const TYPES_SQL = GAME_TYPES.join(",");
const SETTLED = "settled_at IS NOT NULL AND result IN ('win','loss')";

export async function handleTelegramCenterV29(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    // wrapped in a function: the bundler adds a __name helper that must not collide with other layers
    const body = `(function(){const __name=(target,value)=>target;(${predictionsApp.toString()})();})();`;
    return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" } });
  }
  if (path !== API && !path.startsWith(`${API}/`)) return null;
  if (!env?.DB) return json({ ok: false, error: "missing_d1_binding" }, 503);
  const now = Date.now();
  const route = `${request.method} ${path}`;
  try {
    if (route === `GET ${API}/slate`) return await slate(request, env, now);
    if (route === `GET ${API}/games`) return await games(request, env, now);
    if (route === `POST ${API}/predictions`) return await predict(request, env, now);
    if (route === `GET ${API}/me`) return await getMe(request, env, now);
    if (route === `PUT ${API}/me`) return await putMe(request, env);
    if (route === `GET ${API}/leaderboard`) return await leaderboard(request, env, now);
    if (route === `GET ${API}/status`) return await status(env);
  } catch (error) {
    console.error("v29 predictions failed", route, error);
    return json({ ok: false, error: "predictions_failed" }, 503);
  }
  const known = ["/slate", "/games", "/predictions", "/me", "/leaderboard", "/status"].some((p) => path === API + p);
  return json({ ok: false, error: known ? "method_not_allowed" : "not_found" }, known ? 405 : 404);
}

// ---- the games -------------------------------------------------------------------------------------------------------------
const ODDS_SQL = (side) => `(SELECT m.odds FROM winline_events we JOIN winline_markets m ON m.winline_event_id=we.winline_event_id
             WHERE we.game_pk=g.game_pk AND m.market_type='moneyline' AND m.subject_key=g.${side}_tri AND m.active=1 AND m.is_live=0 AND m.odds>1
             ORDER BY m.updated_at DESC LIMIT 1)`;

async function loadGameRows(db, ids) {
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  const r = await db.prepare(`
    SELECT g.game_pk,g.season_id,g.game_type,g.scheduled_start_utc,g.game_state,g.home_tri,g.away_tri,g.home_score,g.away_score,g.period_type,
           ht.name_ru home_name_ru,ht.name_en home_name_en,ht.logo_url home_logo,
           at.name_ru away_name_ru,at.name_en away_name_en,at.logo_url away_logo,
           ${ODDS_SQL("home")} home_odds,
           ${ODDS_SQL("away")} away_odds,
           (SELECT COUNT(*) FROM fan_predictions p WHERE p.game_pk=g.game_pk AND p.pick='home') home_votes,
           (SELECT COUNT(*) FROM fan_predictions p WHERE p.game_pk=g.game_pk AND p.pick='away') away_votes,
           fg.winner,fg.home_xp,fg.away_xp,fg.home_odds closing_home,fg.away_odds closing_away
    FROM games g
    LEFT JOIN teams ht ON ht.tri_code=g.home_tri
    LEFT JOIN teams at ON at.tri_code=g.away_tri
    LEFT JOIN fan_prediction_games fg ON fg.game_pk=g.game_pk
    WHERE g.game_pk IN (${q}) AND g.game_type IN (${TYPES_SQL})
    ORDER BY g.scheduled_start_utc ASC,g.game_pk ASC;
  `).bind(...ids).all();
  return r.results || [];
}

async function loadMine(db, userId, ids) {
  const map = new Map();
  if (!userId || !ids.length) return map;
  const q = ids.map(() => "?").join(",");
  const r = await db.prepare(`SELECT game_pk,pick,result,xp FROM fan_predictions WHERE telegram_user_id=? AND game_pk IN (${q});`).bind(userId, ...ids).all();
  for (const x of r.results || []) map.set(Number(x.game_pk), x);
  return map;
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const teamLogo = (tri) => `https://assets.nhle.com/logos/nhl/svg/${String(tri || "").toUpperCase()}_light.svg`;

function gameBlock(x, mine, now) {
  const open = isOpen(x, now);
  const homeVotes = Number(x.home_votes) || 0;
  const awayVotes = Number(x.away_votes) || 0;
  const total = homeVotes + awayVotes;
  const odds = (h, a) => (num(h) > 1 && num(a) > 1 ? { home: num(h), away: num(a) } : null);
  const winner = x.winner || null;
  const team = (side) => ({ tri: x[`${side}_tri`], name_ru: x[`${side}_name_ru`] || x[`${side}_name_en`] || x[`${side}_tri`], logo: x[`${side}_logo`] || teamLogo(x[`${side}_tri`]) });
  return {
    game_pk: Number(x.game_pk),
    date: nhlDateOf(x.scheduled_start_utc),
    start: x.scheduled_start_utc,
    state: String(x.game_state || "").toUpperCase(),
    open,
    away: team("away"),
    home: team("home"),
    // before the start: the current Winline odds of the winner including overtime; after it: the odds at the start
    odds: open ? odds(x.home_odds, x.away_odds) : odds(x.closing_home ?? x.home_odds, x.closing_away ?? x.away_odds),
    // the split of the fans is shown after one's own pick, and to everybody once the vote is closed
    votes: open && !mine ? { total, home: null, away: null } : { total, home: homeVotes, away: awayVotes },
    my: mine ? { pick: mine.pick, result: mine.result || null, xp: mine.result ? Number(mine.xp) || 0 : null } : null,
    settled: winner ? { winner, home_xp: num(x.home_xp), away_xp: num(x.away_xp), score: winner === "void" ? null : { home: num(x.home_score), away: num(x.away_score), period_type: x.period_type || null } } : null,
  };
}

async function slate(request, env, now) {
  const db = env.DB;
  const auth = await telegramAuth(request, env, false);
  const nowIso = new Date(now).toISOString();
  const next = await db.prepare(`
    SELECT scheduled_start_utc FROM games
    WHERE game_type IN (${TYPES_SQL}) AND game_state IN ('FUT','PRE') AND scheduled_start_utc>?
    ORDER BY scheduled_start_utc ASC LIMIT 1;
  `).bind(nowIso).first();
  const date = next ? nhlDateOf(next.scheduled_start_utc) : null;
  let ids = [];
  if (date) {
    const r = await db.prepare(`
      SELECT game_pk FROM games WHERE game_type IN (${TYPES_SQL}) AND scheduled_start_utc>=? AND scheduled_start_utc<?
      ORDER BY scheduled_start_utc ASC,game_pk ASC LIMIT ${MAX_IDS};
    `).bind(dayStartUtc(date), dayStartUtc(addDays(date, 1))).all();
    ids = (r.results || []).map((x) => Number(x.game_pk));
  }
  const rows = await loadGameRows(db, ids);
  const mine = auth.ok ? await loadMine(db, auth.user.id, ids) : new Map();
  const last = auth.ok ? await lastNight(db, auth.user.id) : null;
  return json({ ok: true, now: nowIso, date, signed_in: auth.ok, games: rows.map((x) => gameBlock(x, mine.get(Number(x.game_pk)), now)), last });
}

// the last game day with settled picks of the person: "угадано 3 из 4 · +32 XP"
async function lastNight(db, userId) {
  const r = await db.prepare(`
    SELECT game_date,COUNT(*) total,SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) correct,SUM(xp) xp
    FROM fan_predictions WHERE telegram_user_id=? AND ${SETTLED}
    GROUP BY game_date ORDER BY game_date DESC LIMIT 1;
  `).bind(userId).first();
  return r ? { date: r.game_date, total: Number(r.total) || 0, correct: Number(r.correct) || 0, xp: Number(r.xp) || 0 } : null;
}

async function games(request, env, now) {
  const raw = String(new URL(request.url).searchParams.get("ids") || "");
  const ids = [...new Set(raw.split(",").map((x) => Number(x.trim())).filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, MAX_IDS);
  if (!ids.length) return json({ ok: false, error: "invalid_ids" }, 400);
  const auth = await telegramAuth(request, env, false);
  const rows = await loadGameRows(env.DB, ids);
  const mine = auth.ok ? await loadMine(env.DB, auth.user.id, ids) : new Map();
  return json({ ok: true, signed_in: auth.ok, games: rows.map((x) => gameBlock(x, mine.get(Number(x.game_pk)), now)) });
}

async function predict(request, env, now) {
  const db = env.DB;
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const gamePk = Number(body?.game_pk);
  const pick = String(body?.pick || "");
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) return json({ ok: false, error: "invalid_game" }, 400);
  if (pick !== "home" && pick !== "away") return json({ ok: false, error: "invalid_pick" }, 400);
  const g = await db.prepare(`SELECT game_pk,season_id,game_type,scheduled_start_utc,game_state,home_tri,away_tri FROM games WHERE game_pk=? LIMIT 1;`).bind(gamePk).first();
  if (!g) return json({ ok: false, error: "game_not_found" }, 404);
  if (!GAME_TYPES.includes(Number(g.game_type))) return json({ ok: false, error: "game_not_in_the_game" }, 409);
  if (!isOpen(g, now)) return json({ ok: false, error: "voting_closed" }, 409);
  await upsertTelegramUser(db, auth.user);
  const tri = pick === "home" ? g.home_tri : g.away_tri;
  const odds = await db.prepare(`
    SELECT m.odds FROM winline_events we JOIN winline_markets m ON m.winline_event_id=we.winline_event_id
    WHERE we.game_pk=? AND m.market_type='moneyline' AND m.subject_key=? AND m.active=1 AND m.is_live=0 AND m.odds>1
    ORDER BY m.updated_at DESC LIMIT 1;
  `).bind(gamePk, tri).first();
  await db.prepare(`
    INSERT INTO fan_predictions(telegram_user_id,game_pk,pick,pick_tri,odds_at_pick,game_date,season_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id,game_pk) DO UPDATE SET pick=excluded.pick,pick_tri=excluded.pick_tri,odds_at_pick=excluded.odds_at_pick,updated_at=CURRENT_TIMESTAMP
    WHERE fan_predictions.settled_at IS NULL;
  `).bind(auth.user.id, gamePk, pick, tri, num(odds?.odds), nhlDateOf(g.scheduled_start_utc), String(g.season_id)).run();
  const rows = await loadGameRows(db, [gamePk]);
  const mine = await loadMine(db, auth.user.id, [gamePk]);
  return json({ ok: true, game: gameBlock(rows[0], mine.get(gamePk), now) });
}

// ---- me and the table ------------------------------------------------------------------------------------------------------
function periodWhere(period, now) {
  const today = nhlDateOf(new Date(now).toISOString());
  const range = periodRange(period, today);
  if (!range) return null;
  if (range.season) return { period, season: range.season, sql: "season_id=?", args: [range.season] };
  return { period, from: range.from, to: range.to, sql: "game_date BETWEEN ? AND ?", args: [range.from, range.to] };
}

async function rankOf(db, userId, where) {
  const r = await db.prepare(`
    WITH t AS (
      SELECT telegram_user_id,SUM(xp) xp,SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) correct,COUNT(*) total
      FROM fan_predictions WHERE ${SETTLED} AND ${where.sql} GROUP BY telegram_user_id
    )
    SELECT m.xp,m.correct,m.total,(SELECT COUNT(*) FROM t) players,
           (SELECT COUNT(*) FROM t o WHERE o.xp>m.xp OR (o.xp=m.xp AND o.correct>m.correct) OR (o.xp=m.xp AND o.correct=m.correct AND o.total<m.total)
              OR (o.xp=m.xp AND o.correct=m.correct AND o.total=m.total AND o.telegram_user_id<m.telegram_user_id))+1 rank
    FROM t m WHERE m.telegram_user_id=?;
  `).bind(...where.args, userId).first();
  return r ? { rank: Number(r.rank), players: Number(r.players), xp: Number(r.xp) || 0, correct: Number(r.correct) || 0, total: Number(r.total) || 0 } : null;
}

async function getMe(request, env, now) {
  const db = env.DB;
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const id = auth.user.id;
  const [totals, profile, prefs, recent] = await Promise.all([
    db.prepare(`
      SELECT COALESCE(SUM(xp),0) xp,COUNT(*) total,
             SUM(CASE WHEN ${SETTLED} THEN 1 ELSE 0 END) settled,
             SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) correct,
             SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) pending
      FROM fan_predictions WHERE telegram_user_id=?;
    `).bind(id).first(),
    db.prepare(`SELECT display_username FROM app_user_profiles WHERE telegram_user_id=? LIMIT 1;`).bind(id).first().catch(() => null),
    db.prepare(`SELECT morning_digest FROM fan_profiles WHERE telegram_user_id=? LIMIT 1;`).bind(id).first(),
    db.prepare(`
      SELECT p.game_pk,p.pick,p.pick_tri,p.result,p.xp,g.home_tri,g.away_tri,g.scheduled_start_utc start
      FROM fan_predictions p JOIN games g ON g.game_pk=p.game_pk
      WHERE p.telegram_user_id=? AND p.settled_at IS NOT NULL AND p.result IN ('win','loss')
      ORDER BY g.scheduled_start_utc DESC LIMIT 10;
    `).bind(id).all(),
  ]);
  const ranks = {};
  for (const period of PERIODS) ranks[period] = await rankOf(db, id, periodWhere(period, now));
  const settled = Number(totals?.settled) || 0;
  const correct = Number(totals?.correct) || 0;
  return json({
    ok: true,
    label: fanLabel(id, profile?.display_username),
    has_nick: Boolean(profile?.display_username),
    level: levelOf(totals?.xp),
    stats: { total: Number(totals?.total) || 0, settled, correct, pending: Number(totals?.pending) || 0, accuracy: settled ? Math.round((100 * correct) / settled) : null },
    ranks,
    recent: (recent.results || []).map((x) => ({ game_pk: Number(x.game_pk), start: x.start, away_tri: x.away_tri, home_tri: x.home_tri, pick_tri: x.pick_tri, result: x.result, xp: Number(x.xp) || 0 })),
    prefs: { morning_digest: prefs ? Number(prefs.morning_digest) === 1 : true },
  });
}

async function putMe(request, env) {
  const auth = await telegramAuth(request, env, true);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  if (typeof body?.morning_digest !== "boolean") return json({ ok: false, error: "invalid_settings" }, 400);
  await upsertTelegramUser(env.DB, auth.user);
  await env.DB.prepare(`
    INSERT INTO fan_profiles(telegram_user_id,morning_digest,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET morning_digest=excluded.morning_digest,updated_at=CURRENT_TIMESTAMP;
  `).bind(auth.user.id, body.morning_digest ? 1 : 0).run();
  return json({ ok: true, prefs: { morning_digest: body.morning_digest } });
}

async function boardRows(db, where) {
  const r = await db.prepare(`
    SELECT p.telegram_user_id id,SUM(p.xp) xp,SUM(CASE WHEN p.result='win' THEN 1 ELSE 0 END) correct,COUNT(*) total,
           MAX(a.display_username) nick,
           MAX(CASE WHEN a.avatar_base64 IS NOT NULL AND a.avatar_base64<>'' THEN 1 ELSE 0 END) has_avatar
    FROM fan_predictions p LEFT JOIN app_user_profiles a ON a.telegram_user_id=p.telegram_user_id
    WHERE p.settled_at IS NOT NULL AND p.result IN ('win','loss') AND p.${where.sql}
    GROUP BY p.telegram_user_id
    ORDER BY xp DESC,correct DESC,total ASC,p.telegram_user_id ASC
    LIMIT ${BOARD_LIMIT};
  `).bind(...where.args).all();
  return (r.results || []).map((x, i) => ({
    rank: i + 1,
    label: fanLabel(x.id, x.nick),
    avatar_url: Number(x.has_avatar) ? AVATAR_PATH + x.id : null,
    xp: Number(x.xp) || 0,
    correct: Number(x.correct) || 0,
    total: Number(x.total) || 0,
    level: levelOf(x.xp).name,
  }));
}

async function leaderboard(request, env, now) {
  const period = String(new URL(request.url).searchParams.get("period") || "week");
  if (!PERIODS.includes(period)) return json({ ok: false, error: "invalid_period" }, 400);
  const where = periodWhere(period, now);
  // the table itself is the same for everybody: kept a minute at the edge; "me" is added per person
  const cacheKey = new Request(`https://cache.hoh/v29/board/${period}/${where.season || `${where.from}_${where.to}`}`);
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  let table = null;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) table = await hit.json().catch(() => null);
  }
  if (!table) {
    const rows = await boardRows(env.DB, where);
    const players = await env.DB.prepare(`SELECT COUNT(DISTINCT telegram_user_id) n FROM fan_predictions WHERE ${SETTLED} AND ${where.sql};`).bind(...where.args).first();
    table = { rows, players: Number(players?.n) || 0 };
    if (cache) await cache.put(cacheKey, new Response(JSON.stringify(table), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${BOARD_CACHE_SECONDS}` } })).catch(() => {});
  }
  const auth = await telegramAuth(request, env, false);
  const me = auth.ok ? await rankOf(env.DB, auth.user.id, where) : null;
  return json({ ok: true, period, from: where.from || null, to: where.to || null, season: where.season || null, players: table.players, rows: table.rows, me });
}

async function status(env) {
  const r = await env.DB.prepare(`
    SELECT (SELECT COUNT(*) FROM fan_predictions) predictions,
           (SELECT COUNT(DISTINCT telegram_user_id) FROM fan_predictions) players,
           (SELECT COUNT(*) FROM fan_predictions WHERE settled_at IS NULL) unsettled,
           (SELECT COUNT(*) FROM fan_prediction_games) settled_games,
           (SELECT COUNT(*) FROM notification_log WHERE notification_type='fan_morning_digest' AND sent_at>=datetime('now','-24 hours')) digests_24h;
  `).first();
  return json({ ok: true, ...Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, Number(v) || 0])) });
}

// ---- settlement of the finished games (cron) ------------------------------------------------------------------------------
// The odds at the start: the last pre-match Winline snapshot of the "winner including overtime" market before the scheduled start.
async function closingOdds(db, g) {
  const out = { home: null, away: null };
  const r = await db.prepare(`
    SELECT subject_key,odds FROM winline_market_snapshots
    WHERE game_pk=? AND market_type='moneyline' AND is_live=0 AND odds>1 AND captured_at<=?
    ORDER BY captured_at DESC LIMIT 12;
  `).bind(g.game_pk, g.scheduled_start_utc).all().catch(() => ({ results: [] }));
  for (const x of r.results || []) {
    if (out.home === null && x.subject_key === g.home_tri) out.home = Number(x.odds);
    if (out.away === null && x.subject_key === g.away_tri) out.away = Number(x.odds);
  }
  if (out.home !== null && out.away !== null) return out;
  // no snapshot: the current pre-match line, if it was last written before the start ("YYYY-MM-DD HH:MM:SS" is UTC)
  const c = await db.prepare(`
    SELECT m.subject_key,m.odds FROM winline_events we JOIN winline_markets m ON m.winline_event_id=we.winline_event_id
    WHERE we.game_pk=? AND m.market_type='moneyline' AND m.is_live=0 AND m.odds>1 AND replace(m.updated_at,' ','T')<=?
    ORDER BY m.updated_at DESC LIMIT 12;
  `).bind(g.game_pk, String(g.scheduled_start_utc).replace(/Z$/, "")).all().catch(() => ({ results: [] }));
  for (const x of c.results || []) {
    if (out.home === null && x.subject_key === g.home_tri) out.home = Number(x.odds);
    if (out.away === null && x.subject_key === g.away_tri) out.away = Number(x.odds);
  }
  return out;
}

export async function runFanPredictionSettlement(env, { now = Date.now(), limit = 20 } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "missing_d1_binding" };
  const r = await db.prepare(`
    SELECT g.game_pk,g.game_state,g.scheduled_start_utc,g.home_tri,g.away_tri,g.home_score,g.away_score
    FROM games g
    WHERE g.game_pk IN (SELECT DISTINCT game_pk FROM fan_predictions WHERE settled_at IS NULL)
      AND g.game_state IN ('FINAL','OFF','PPD','CNCL')
    ORDER BY g.scheduled_start_utc ASC LIMIT ?;
  `).bind(limit).all();
  const summary = { ok: true, games: 0, predictions: 0, void_games: 0, skipped: 0 };
  const settledAt = new Date(now).toISOString();
  for (const g of r.results || []) {
    const votes = await db.prepare(`SELECT pick,COUNT(*) n FROM fan_predictions WHERE game_pk=? GROUP BY pick;`).bind(g.game_pk).all();
    const count = (side) => Number((votes.results || []).find((x) => x.pick === side)?.n) || 0;
    const odds = await closingOdds(db, g);
    const s = settleGame({ state: g.game_state, homeScore: g.home_score, awayScore: g.away_score, homeOdds: odds.home, awayOdds: odds.away, homeVotes: count("home"), awayVotes: count("away") });
    if (!s) { summary.skipped++; continue; }
    const update = s.winner === "void"
      ? db.prepare(`UPDATE fan_predictions SET result='void',xp=0,settled_at=? WHERE game_pk=? AND settled_at IS NULL;`).bind(settledAt, g.game_pk)
      : db.prepare(`
          UPDATE fan_predictions SET result=CASE WHEN pick=? THEN 'win' ELSE 'loss' END,
                 xp=CASE WHEN pick='home' THEN ? ELSE ? END,settled_at=?
          WHERE game_pk=? AND settled_at IS NULL;
        `).bind(s.winner, s.home.total, s.away.total, settledAt, g.game_pk);
    const record = db.prepare(`
      INSERT INTO fan_prediction_games(game_pk,winner,home_votes,away_votes,home_odds,away_odds,home_xp,away_xp,settled_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(game_pk) DO UPDATE SET winner=excluded.winner,home_votes=excluded.home_votes,away_votes=excluded.away_votes,home_odds=excluded.home_odds,
        away_odds=excluded.away_odds,home_xp=excluded.home_xp,away_xp=excluded.away_xp,settled_at=excluded.settled_at;
    `).bind(g.game_pk, s.winner, count("home"), count("away"), odds.home, odds.away, s.home.total, s.away.total, settledAt);
    await db.batch([update, record]);
    summary.games++;
    summary.predictions += count("home") + count("away");
    if (s.winner === "void") summary.void_games++;
  }
  return summary;
}

// ---- the morning message of the bot (cron) ---------------------------------------------------------------------------------
export async function runFanPredictionDigest(env, { now = Date.now(), dryRun = false, budget = DIGEST_BUDGET, send = sendTelegram } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "missing_d1_binding" };
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!dryRun && !token) return { ok: false, error: "missing_telegram_center_token" };
  const users = await db.prepare(`
    SELECT p.telegram_user_id id,MAX(COALESCE(n.timezone_name,'')) tz,MAX(COALESCE(f.morning_digest,1)) morning,MAX(COALESCE(a.no_spoilers,0)) no_spoilers,
           MAX(u.notifications_enabled) enabled
    FROM fan_predictions p
    JOIN telegram_users u ON u.telegram_user_id=p.telegram_user_id
    LEFT JOIN notification_user_preferences n ON n.telegram_user_id=p.telegram_user_id
    LEFT JOIN fan_profiles f ON f.telegram_user_id=p.telegram_user_id
    LEFT JOIN app_user_profiles a ON a.telegram_user_id=p.telegram_user_id
    WHERE p.settled_at IS NOT NULL AND p.reported_at IS NULL
    GROUP BY p.telegram_user_id ORDER BY p.telegram_user_id ASC LIMIT 500;
  `).all();
  const summary = { ok: true, dry_run: dryRun, due: 0, sent: 0, skipped_off: 0, skipped_hour: 0, skipped_duplicate: 0, deferred_budget: 0, failed: 0, messages: [] };
  const reportedAt = new Date(now).toISOString();
  const markReported = (id) => db.prepare(`UPDATE fan_predictions SET reported_at=? WHERE telegram_user_id=? AND settled_at IS NOT NULL AND reported_at IS NULL;`).bind(reportedAt, id).run();
  for (const u of users.results || []) {
    const id = Number(u.id);
    // switched off in the game, or no messages at all from the bot: nothing is sent, nothing piles up
    if (Number(u.morning) !== 1 || Number(u.enabled) !== 1) {
      summary.skipped_off++;
      if (!dryRun) await markReported(id);
      continue;
    }
    const local = localParts(now, String(u.tz || "").trim() || DEFAULT_TIMEZONE);
    if (!local || local.hour < DIGEST_FROM_HOUR || local.hour > DIGEST_TO_HOUR) { summary.skipped_hour++; continue; }
    const rows = await db.prepare(`
      SELECT p.game_pk,p.pick_tri,p.result,p.xp,g.home_tri,g.away_tri
      FROM fan_predictions p JOIN games g ON g.game_pk=p.game_pk
      WHERE p.telegram_user_id=? AND p.settled_at IS NOT NULL AND p.reported_at IS NULL
      ORDER BY g.scheduled_start_utc ASC,p.game_pk ASC;
    `).bind(id).all();
    const all = await db.prepare(`SELECT COALESCE(SUM(xp),0) xp FROM fan_predictions WHERE telegram_user_id=? AND settled_at IS NOT NULL;`).bind(id).first();
    const text = digestText(rows.results || [], { levelXp: Number(all?.xp) || 0, noSpoilers: Number(u.no_spoilers) === 1 });
    if (!text) { if (!dryRun) await markReported(id); continue; }
    summary.due++;
    if (dryRun) { summary.messages.push({ user_id: id, local_date: local.date, text }); continue; }
    if (summary.sent >= budget) { summary.deferred_budget++; continue; }
    const key = `fan:morning:${local.date}`;
    const reserved = await db.prepare(`
      INSERT OR IGNORE INTO notification_log(notification_key,telegram_user_id,notification_type,subject_type,subject_key,game_pk,payload_json)
      VALUES(?,?,?,?,?,?,?);
    `).bind(key, id, "fan_morning_digest", "fan", "morning", null, JSON.stringify({ local_date: local.date, picks: (rows.results || []).length })).run();
    if (!(Number(reserved?.meta?.changes ?? reserved?.changes ?? 0) > 0)) { summary.skipped_duplicate++; continue; }
    try {
      await send(token, id, text, { inline_keyboard: [[{ text: "Прогнозы на сегодня", web_app: { url: String(env.TELEGRAM_MINI_APP_URL || "").trim() || MINI_APP_URL } }]] });
      await markReported(id);
      summary.sent++;
    } catch (error) {
      const message = String(error?.message || error);
      // the person blocked the bot or never started it: telling the same results again tomorrow makes no sense
      if (/forbidden|blocked|chat not found|deactivated/i.test(message)) await markReported(id);
      else await db.prepare(`DELETE FROM notification_log WHERE notification_key=? AND telegram_user_id=?;`).bind(key, id).run().catch(() => {});
      summary.failed++;
    }
  }
  return summary;
}

async function sendTelegram(token, chatId, text, replyMarkup) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, reply_markup: replyMarkup }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.description || `Telegram ${r.status}`);
}

// ---- Telegram identity (the same check as the profiles of v22) -------------------------------------------------------------
async function upsertTelegramUser(db, user) {
  await db.prepare(`INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,notifications_enabled,updated_at)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
    .bind(user.id, user.username, user.first_name, user.last_name, user.language_code).run();
}

async function telegramAuth(request, env, required) {
  const initData = String(request.headers.get("x-telegram-init-data") || "").trim();
  if (!initData) return required ? { ok: false, error: "missing_telegram_init_data" } : { ok: false, error: "guest" };
  const token = String(env.TELEGRAM_CENTER_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, error: "missing_telegram_center_token" };
  try {
    const params = new URLSearchParams(initData);
    const provided = params.get("hash") || "";
    const authDate = Number(params.get("auth_date") || 0);
    const userRaw = params.get("user") || "";
    params.delete("hash");
    if (!provided || !authDate || !userRaw) return { ok: false, error: "invalid_telegram_init_data" };
    const max = Number(env.TELEGRAM_WEBAPP_MAX_AGE_SECONDS || 86400);
    const age = Number.isFinite(max) ? Math.min(604800, Math.max(300, Math.floor(max))) : 86400;
    if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > age) return { ok: false, error: "telegram_init_data_expired" };
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const e = new TextEncoder();
    const k1 = await crypto.subtle.importKey("raw", e.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", k1, e.encode(token));
    const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", k2, e.encode(check));
    if (!(await secureEqual(hex(new Uint8Array(digest)), provided.toLowerCase()))) return { ok: false, error: "telegram_signature_invalid" };
    const raw = JSON.parse(userRaw);
    const id = Number(raw.id);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: "telegram_user_invalid" };
    return { ok: true, user: { id, username: raw.username || null, first_name: raw.first_name || null, last_name: raw.last_name || null, language_code: raw.language_code || null } };
  } catch {
    return { ok: false, error: "telegram_init_data_invalid" };
  }
}

async function secureEqual(a, b) {
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(String(a))), crypto.subtle.digest("SHA-256", e.encode(String(b)))]);
  const aa = new Uint8Array(x);
  const bb = new Uint8Array(y);
  let d = aa.length ^ bb.length;
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) d |= aa[i] ^ bb[i];
  return d === 0;
}

const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
