// Live Center home page (v27): everything the first screen needs in one answer.
//   - which "mood" the page is in: games are on (live), the night is over (results) or the games are still ahead (schedule);
//   - the games of the day for the score strip;
//   - the freshest goal clips for the goals shelf (the clip index of the highlights server joined with the game list).
//
// Pure functions only: the route in telegram-center-v27-home.js does the loading (D1, NHL, clip server).
import { phaseOf, clipOf, findIndexGame, DEFAULT_CLIPS_BASE } from "./telegram-center-v26-goals-data.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// A game still counts as "ahead" for a few hours after its start: the state in the database can lag behind the real start.
export const STALE_UPCOMING_MS = 6 * HOUR;
// The night is "over" for 14 hours after the last finished game started, unless the next game is close.
export const RESULTS_MAX_AGE_MS = 14 * HOUR;
export const SOON_MS = 3 * HOUR;
// Goals of games that started within this time are candidates for the goals shelf.
export const GOALS_WINDOW_MS = 40 * HOUR;
export const MIN_TILES = 6;
export const MAX_TILES = 16;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The calendar day of a game, exactly as the Matches tab and the match of the day count it: start time minus 8 hours.
export const nhlDateOf = (ms) => new Date(ms - 8 * HOUR).toISOString().slice(0, 10);

const logoOf = (tri) => (tri ? `https://assets.nhle.com/logos/nhl/svg/${String(tri).toUpperCase()}_light.svg` : "");

function teamOf(tri, nameRu, nameEn, logo) {
  return { tri: tri || null, name_ru: nameRu || null, name_en: nameEn || null, logo: logo || logoOf(tri) };
}

export function gameFromRow(row) {
  const state = String(row?.game_state || "").toUpperCase();
  const start = String(row?.scheduled_start_utc || "");
  const startMs = Date.parse(start);
  const finish = String(row?.period_type || "").toUpperCase();
  return {
    game_pk: Number(row.game_pk),
    date: String(row.calendar_date || (Number.isFinite(startMs) ? nhlDateOf(startMs) : "")),
    start,
    start_ms: Number.isFinite(startMs) ? startMs : 0,
    state,
    phase: phaseOf(state),
    game_type: num(row.game_type),
    is_playoff: Number(row.game_type) === 3,
    away: teamOf(row.away_tri, row.away_name_ru, row.away_name_en, row.away_logo),
    home: teamOf(row.home_tri, row.home_name_ru, row.home_name_en, row.home_logo),
    away_score: num(row.away_score),
    home_score: num(row.home_score),
    finish: finish === "OT" || finish === "SO" ? finish : null,
  };
}

const byStart = (a, b) => a.start_ms - b.start_ms || a.game_pk - b.game_pk;

// Decide the mood of the page and which days the strip and the match of the day look at.
//   live     some game is on: both look at that day;
//   results  the night is over (the last game finished and nothing starts soon): the strip shows the results of that day,
//            the match of the day is the first game of the next day that has games;
//   schedule the games are still ahead: both look at the next day that has games;
//   idle     nothing around (the off-season).
export function pickHome(games, now) {
  const today = nhlDateOf(now);
  const playable = (games || []).filter((g) => g.phase !== "postponed");
  const live = playable.filter((g) => g.phase === "live").sort(byStart);
  const finals = playable.filter((g) => g.phase === "final" && g.start_ms <= now).sort(byStart);
  const ahead = playable.filter((g) => g.phase === "upcoming" && g.start_ms > now - STALE_UPCOMING_MS).sort(byStart);
  const lastFinal = finals[finals.length - 1] || null;
  const next = ahead[0] || null;

  if (live.length) return { mode: "live", today, stripDay: live[0].date, heroDay: live[0].date };

  const nightOver = lastFinal && now - lastFinal.start_ms < RESULTS_MAX_AGE_MS && !(next && next.start_ms - now < SOON_MS);
  if (nightOver) {
    const after = ahead.find((g) => g.date > lastFinal.date);
    return { mode: "results", today, stripDay: lastFinal.date, heroDay: after ? after.date : lastFinal.date };
  }
  if (next) return { mode: "schedule", today, stripDay: next.date, heroDay: next.date };
  if (lastFinal) return { mode: "results", today, stripDay: lastFinal.date, heroDay: lastFinal.date };
  return { mode: "idle", today, stripDay: null, heroDay: null };
}

const PHASE_WEIGHT = { live: 0, upcoming: 1, final: 2, postponed: 3 };

// The strip: games on now first, then the ones still ahead (soonest first), then the finished ones.
export function stripOf(games, day) {
  return (games || [])
    .filter((g) => g.date === day)
    .sort((a, b) => (PHASE_WEIGHT[a.phase] ?? 1) - (PHASE_WEIGHT[b.phase] ?? 1) || byStart(a, b));
}

export function publicGame(g) {
  return {
    game_pk: g.game_pk,
    date: g.date,
    start: g.start,
    state: g.state,
    phase: g.phase,
    is_playoff: g.is_playoff,
    away: g.away,
    home: g.home,
    away_score: g.away_score,
    home_score: g.home_score,
    finish: g.finish,
  };
}

// ---- goal clips ------------------------------------------------------------------------------------------------------------
export function periodShort(n, gameType) {
  const p = Number(n) || 0;
  if (p <= 3) return `${p}-й`;
  if (Number(gameType) === 3) return p === 4 ? "ОТ" : `${p - 3}ОТ`;
  return "ОТ";
}

function toSeconds(mmss) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(mmss || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

// The index keeps the time LEFT in the period; the app shows the time played, like the NHL feed does.
export function playedTime(period, remaining, gameType) {
  const left = toSeconds(remaining);
  if (left === null) return null;
  const length = Number(period) <= 3 || Number(gameType) === 3 ? 1200 : 300;
  const played = Math.max(0, length - left);
  return `${pad2(Math.floor(played / 60))}:${pad2(played % 60)}`;
}

// A rough wall-clock moment of a goal, only used to put goals of games played at the same time in the right order
// (start + played game time + about 17 minutes per intermission).
export function goalMoment(game, goal) {
  const period = Math.max(1, Number(goal?.period) || 1);
  const left = toSeconds(goal?.time_remaining);
  const length = period <= 3 || game.game_type === 3 ? 1200 : 300;
  const played = left === null ? 0 : Math.max(0, length - left);
  const before = period <= 3 ? (period - 1) * 1200 : 3 * 1200 + (period - 4) * (game.game_type === 3 ? 1200 : 300);
  return game.start_ms + (before + played) * 1000 + (period - 1) * 17 * MIN;
}

function tileOf(game, goal, base) {
  const clip = clipOf(goal, base);
  if (!clip || clip.state !== "ready" || !clip.url) return null;
  const team = String(goal.team || "").toUpperCase() || null;
  return {
    game_pk: game.game_pk,
    event_id: num(goal.event_id),
    date: game.date,
    live: game.phase === "live",
    moment: goalMoment(game, goal),
    team,
    scorer_id: num(goal.scorer_id),
    scorer_ru: null,
    scorer_en: String(goal.scorer || "").trim() || null,
    period: num(goal.period),
    period_short: periodShort(goal.period, game.game_type),
    time: playedTime(goal.period, goal.time_remaining, game.game_type),
    away: { tri: game.away.tri, logo: game.away.logo },
    home: { tri: game.home.tri, logo: game.home.logo },
    away_score: num(goal.away_score),
    home_score: num(goal.home_score),
    clip_url: clip.url,
    poster_url: clip.poster_url || null,
    duration: clip.duration,
  };
}

// The goals shelf: goals with a ready clip from games that are on or finished within the last 40 hours.
// The newest day with clips comes first; if it has fewer than MIN_TILES goals the day before fills the shelf.
export function buildGoalTiles({ games, index, indexOk, now, clipsBase = DEFAULT_CLIPS_BASE }) {
  if (!indexOk) return { ok: false, day: null, live: false, total: 0, items: [] };
  const candidates = (games || []).filter((g) => (g.phase === "live" || g.phase === "final") && g.start_ms <= now && now - g.start_ms <= GOALS_WINDOW_MS);
  const all = [];
  for (const game of candidates) {
    const entry = findIndexGame(index, game.game_pk);
    for (const goal of entry?.goals || []) {
      const tile = tileOf(game, goal, clipsBase);
      if (tile) all.push(tile);
    }
  }
  const days = [...new Set(all.map((t) => t.date))].sort().reverse();
  if (!days.length) return { ok: true, day: null, live: false, total: 0, items: [] };
  const picked = [];
  for (const day of days) {
    picked.push(...all.filter((t) => t.date === day));
    if (picked.length >= MIN_TILES) break;
  }
  picked.sort((a, b) => b.moment - a.moment || (b.event_id ?? 0) - (a.event_id ?? 0));
  return {
    ok: true,
    day: days[0],
    live: picked.some((t) => t.live),
    total: picked.length,
    items: picked.slice(0, MAX_TILES).map(({ moment, ...tile }) => tile),
  };
}

export function applyNames(tiles, names) {
  for (const t of tiles.items) {
    const known = names?.get ? names.get(t.scorer_id) : names?.[t.scorer_id];
    if (known && String(known).trim()) t.scorer_ru = String(known).trim();
  }
  return tiles;
}

// The live label and exact score of the match of the day come from the NHL feed (the database can be a minute behind).
export function applyHeroLive(payload, live) {
  if (!live || !payload.featured) return payload;
  const pk = Number(payload.featured.game_pk);
  const patch = (g) => {
    if (Number(g.game_pk) !== pk) return g;
    return {
      ...g,
      state: live.code || g.state,
      away_score: live.away_score ?? g.away_score,
      home_score: live.home_score ?? g.home_score,
    };
  };
  payload.games = payload.games.map(patch);
  payload.featured = { ...patch(payload.featured), game_state: live.code || payload.featured.game_state, live_label: live.label || payload.featured.live_label || "" };
  return payload;
}

export function buildHomePayload({ games, now, featured = null, index = null, indexOk = false, clipsBase = DEFAULT_CLIPS_BASE }) {
  const pick = pickHome(games, now);
  const strip = pick.stripDay ? stripOf(games, pick.stripDay) : [];
  return {
    ok: true,
    version: "27.0",
    now: new Date(now).toISOString(),
    mode: pick.mode,
    today: pick.today,
    strip_day: pick.stripDay,
    hero_day: pick.heroDay,
    games: strip.map(publicGame),
    featured,
    goals: buildGoalTiles({ games, index, indexOk, now, clipsBase }),
  };
}
