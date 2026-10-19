// Live Center v29: the game of the fans. "Кто победит?" on every NHL game (the winner including overtime and the shootout),
// points (XP), levels and the table of the best fans. The pure rules live here: the API, the settlement of the finished games,
// the morning message of the bot and the tests all use the same functions.

// Ten levels with numbers (the owner: «второй уровень быстро, третий подольше… сможем сделать 10 уровней? Может делать их числами?»).
// A right winner gives about 11 XP: level 2 comes with the first good pick, level 10 after a season of steady play.
const LEVEL_MINS = [0, 20, 60, 120, 220, 380, 620, 1000, 1600, 2500];
// the number stays the level; next to it a hockey title with a wink (the owner, package 1: «1 · Заливщик льда… 10 · Легенда»)
const LEVEL_NOTES = ["Заливщик льда", "Подносчик шайб", "Точильщик коньков", "Голос трибуны", "Капитан фан-сектора", "Скаут", "Тренер-аналитик", "Генменеджер", "Зал славы", "Легенда"];
export const LEVELS = LEVEL_MINS.map((min, i) => ({ key: `l${i + 1}`, name: `Уровень ${i + 1}`, min, note: LEVEL_NOTES[i] }));

// +1 for every pick on a game that was played, +10 for the right winner, +10 more when the winner was the underdog by the Winline
// odds at the start, +5 more when fewer than 30% of the fans (out of at least 10) picked it.
export const XP_RULES = { vote: 1, correct: 10, underdog: 10, minority: 5, exact: 25 };
// right picks in a row: every 5th one brings a star and extra XP — 5 → ⭐ +15, 10 → ⭐⭐ +30, 15, 20… → ⭐⭐⭐ +50
export const STREAK_STEP = 5;
const STREAK_XP = [15, 30, 50];
// the exact score: a guess of the final score (the official one: an overtime or shootout winner counts as one more goal)
export const SCORE_MAX = 15;
export const UNDERDOG_MIN_ODDS = 2.1;
export const MINORITY_SHARE = 0.3;
export const MINORITY_MIN_VOTES = 10;

export const GAME_TYPES = [2, 3]; // regular season and playoffs; no preseason
export const OPEN_STATES = new Set(["FUT", "PRE"]);
export const FINAL_STATES = new Set(["FINAL", "OFF"]);
export const VOID_STATES = new Set(["PPD", "CNCL"]);
export const PERIODS = ["week", "month", "season"];
export const DIGEST_FROM_HOUR = 10; // the morning message: 10:00–13:59 local time of the person (Moscow when unknown)
export const DIGEST_TO_HOUR = 13;
export const DEFAULT_TIMEZONE = "Europe/Moscow";
// "Вы точнее, чем 63% болельщиков": the share of the other fans (with at least this many played picks) one is better than
export const PEER_MIN_PICKS = 5;
export const PEER_MIN_FANS = 3;
export const SPLIT_MIN_VOTES = 5; // a share of the fans says something from five votes (not "100%" after one)

const DAY_MS = 86400000;

export function levelOf(value) {
  const xp = Math.max(0, Math.floor(Number(value) || 0));
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i].min) index = i;
  const current = LEVELS[index];
  const next = LEVELS[index + 1] || null;
  const progress = next ? (xp - current.min) / (next.min - current.min) : 1;
  return {
    key: current.key, n: index + 1, name: current.name, note: current.note, min: current.min, xp,
    next: next ? { key: next.key, n: index + 2, name: next.name, min: next.min } : null,
    to_next: next ? next.min - xp : 0,
    progress: Math.max(0, Math.min(1, progress)),
  };
}

// The streak a pick makes: the right picks in a row before it (in the order of the games) plus this one, or 0.
export function streakAfter(previousStreak, won) {
  return won ? Math.max(0, Math.floor(Number(previousStreak) || 0)) + 1 : 0;
}
export function streakBonus(streak) {
  const n = Math.floor(Number(streak) || 0);
  if (n <= 0 || n % STREAK_STEP !== 0) return 0;
  return STREAK_XP[Math.min(STREAK_XP.length, n / STREAK_STEP) - 1];
}
export const starsOf = (streak) => Math.min(3, Math.floor((Math.floor(Number(streak) || 0)) / STREAK_STEP));

// The share of the others one is better than (a tie counts half), 0–100; null with too few others to say anything.
export function betterThanPct(mine, others) {
  const m = Number(mine);
  const list = (others || []).map(Number).filter(Number.isFinite);
  if (!Number.isFinite(m) || list.length < PEER_MIN_FANS) return null;
  let below = 0, equal = 0;
  for (const o of list) { if (o < m) below++; else if (o === m) equal++; }
  return Math.round((100 * (below + equal / 2)) / list.length);
}

// The share of the fans who picked the same side, when there are enough votes to say it.
export function sideShare(pickVotes, totalVotes) {
  const v = Number(pickVotes) || 0;
  const t = Number(totalVotes) || 0;
  return t >= SPLIT_MIN_VOTES ? Math.round((100 * v) / t) : null;
}

// The personal fact of a settled pick (the owner: «ты один из 14% пользователей, которые верили…»), or null.
export function personalFact({ result, pick_tri, pick_votes, total_votes, streak } = {}) {
  if (result !== "win") return null;
  const n = Math.floor(Number(streak) || 0);
  if (n >= STREAK_STEP && n % STREAK_STEP === 0) return `${"⭐".repeat(starsOf(n))} ${n} угаданных подряд!`;
  const share = sideShare(pick_votes, total_votes);
  if (share !== null && share < 50) return `вы среди ${Math.max(1, share)}% болельщиков, которые верили в ${pick_tri}`;
  if (n >= 3) return `${n} угаданных подряд`;
  return null;
}

// A guess of the exact score: whole numbers 0–15, and the picked team must win it. null = not a valid guess.
export function validScore(pick, score) {
  if (!score || (pick !== "home" && pick !== "away")) return null;
  const home = Number(score.home);
  const away = Number(score.away);
  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= SCORE_MAX;
  if (!ok(home) || !ok(away) || home === away) return null;
  if ((pick === "home") !== (home > away)) return null;
  return { home, away };
}

export function isExactScore(prediction, homeScore, awayScore) {
  const h = Number(prediction?.score_home);
  const a = Number(prediction?.score_away);
  return prediction?.score_home != null && prediction?.score_away != null && h === Number(homeScore) && a === Number(awayScore);
}

// The game day of the NHL: the same as date(datetime(scheduled_start_utc,'-8 hours')) in the SQL of the other layers.
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

export function nhlDateOf(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? new Date(t - 8 * 3600000).toISOString().slice(0, 10) : null;
}

export function addDays(date, days) {
  const t = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t + days * DAY_MS).toISOString().slice(0, 10) : null;
}

// The start of the game day in UTC (08:00): the games of a day are the ones that start between this moment and the next one.
export const dayStartUtc = (date) => `${date}T08:00:00Z`;

// Open = the game has not started: the NHL still lists it as future and its scheduled start is ahead.
export function isOpen(game, nowMs) {
  const state = String(game?.game_state || "").toUpperCase();
  const start = Date.parse(String(game?.scheduled_start_utc || ""));
  return OPEN_STATES.has(state) && Number.isFinite(start) && nowMs < start;
}

export function isUnderdog(pickOdds, otherOdds) {
  const a = Number(pickOdds);
  const b = Number(otherOdds);
  return Number.isFinite(a) && Number.isFinite(b) && a >= UNDERDOG_MIN_ODDS && a > b;
}

export function isMinority(pickVotes, totalVotes) {
  const v = Number(pickVotes) || 0;
  const t = Number(totalVotes) || 0;
  return t >= MINORITY_MIN_VOTES && v / t < MINORITY_SHARE;
}

export function sidePoints({ won, pickOdds, otherOdds, pickVotes, totalVotes }) {
  const out = { vote: XP_RULES.vote, correct: 0, underdog: 0, minority: 0 };
  if (won) {
    out.correct = XP_RULES.correct;
    if (isUnderdog(pickOdds, otherOdds)) out.underdog = XP_RULES.underdog;
    if (isMinority(pickVotes, totalVotes)) out.minority = XP_RULES.minority;
  }
  out.total = out.vote + out.correct + out.underdog + out.minority;
  return out;
}

const NO_POINTS = Object.freeze({ vote: 0, correct: 0, underdog: 0, minority: 0, total: 0 });

// null = not settled yet (the game is not over, or its score is not final)
export function settleGame({ state, homeScore, awayScore, homeOdds, awayOdds, homeVotes, awayVotes }) {
  const code = String(state || "").toUpperCase();
  if (VOID_STATES.has(code)) return { winner: "void", home: NO_POINTS, away: NO_POINTS };
  if (!FINAL_STATES.has(code)) return null;
  const hs = Number(homeScore);
  const as = Number(awayScore);
  if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) return null;
  const winner = hs > as ? "home" : "away";
  const hv = Number(homeVotes) || 0;
  const av = Number(awayVotes) || 0;
  return {
    winner,
    home: sidePoints({ won: winner === "home", pickOdds: homeOdds, otherOdds: awayOdds, pickVotes: hv, totalVotes: hv + av }),
    away: sidePoints({ won: winner === "away", pickOdds: awayOdds, otherOdds: homeOdds, pickVotes: av, totalVotes: hv + av }),
  };
}

// NHL seasons start in September: a date in October 2026 belongs to "20262027".
export function seasonOf(date) {
  const y = Number(String(date || "").slice(0, 4));
  const m = Number(String(date || "").slice(5, 7));
  if (!y || !m) return null;
  return m >= 9 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

// The periods of the table, by the game day: the week from Monday to Sunday, the calendar month, the season.
export function periodRange(period, today) {
  if (period === "season") return { season: seasonOf(today) };
  const t = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  if (period === "week") {
    const dow = (new Date(t).getUTCDay() + 6) % 7;
    const from = addDays(today, -dow);
    return { from, to: addDays(from, 6) };
  }
  if (period === "month") {
    const d = new Date(t);
    const from = `${today.slice(0, 7)}-01`;
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
    return { from, to };
  }
  return null;
}

// A person without a nickname is "Болельщик 4821": a stable number instead of the name from Telegram.
export function fanCode(id) {
  let h = 2166136261;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return String(1000 + (h % 9000));
}

export function fanLabel(id, nick) {
  const n = String(nick || "").trim().replace(/^@/, "");
  return n ? `@${n}` : `Болельщик ${fanCode(id)}`;
}

// The morning message of the bot. rows: the settled picks not told yet (with pick_votes/total_votes/streak for the facts);
// levelXp: all the points of the person; betterPct: the share of the fans the person is more accurate than (null = not shown).
export function digestText(rows, { levelXp = 0, noSpoilers = false, betterPct = null } = {}) {
  const played = (rows || []).filter((r) => r.result === "win" || r.result === "loss");
  if (!played.length) return null;
  if (noSpoilers) return "🏒 Ваши прогнозы рассчитаны.\nВключён режим без спойлеров — итоги и очки смотрите в приложении.";
  const lines = played.map((r) => {
    const fact = personalFact(r);
    return `${r.result === "win" ? "✅" : "❌"} ${r.away_tri} — ${r.home_tri}: вы выбрали ${r.pick_tri}${Number(r.exact) === 1 ? " · 🎯 точный счёт" : ""} · +${r.xp} XP${fact ? `\n    ${fact}` : ""}`;
  });
  const correct = played.filter((r) => r.result === "win").length;
  const xp = played.reduce((sum, r) => sum + (Number(r.xp) || 0), 0);
  const level = levelOf(levelXp);
  const next = level.next ? `, до уровня ${level.next.n}: ${formatXp(level.to_next)} XP` : " — высший";
  // never "you are the last": only how many one is better than, and only when it is somebody
  const better = Number(betterPct) > 0 ? `\nВаши прогнозы точнее, чем у ${Math.round(Number(betterPct))}% болельщиков` : "";
  return `🏒 Итоги ваших прогнозов\n\n${lines.join("\n")}\n\nУгадано ${correct} из ${played.length} · +${xp} XP\n${level.name} · ${level.note} — ${formatXp(level.xp)} XP${next}${better}`;
}

export function formatXp(v) {
  return String(Math.max(0, Math.floor(Number(v) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// The local date and hour of a person, for the morning message.
export function localParts(nowMs, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
    const m = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return { date: `${m.year}-${m.month}-${m.day}`, hour: Number(m.hour) };
  } catch {
    return timezone && timezone !== DEFAULT_TIMEZONE ? localParts(nowMs, DEFAULT_TIMEZONE) : null;
  }
}
