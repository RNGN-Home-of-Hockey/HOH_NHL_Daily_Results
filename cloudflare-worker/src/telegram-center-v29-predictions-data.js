// Live Center v29: the game of the fans. "Кто победит?" on every NHL game (the winner including overtime and the shootout),
// points (XP), levels and the table of the best fans. The pure rules live here: the API, the settlement of the finished games,
// the morning message of the bot and the tests all use the same functions.

export const LEVELS = [
  { key: "novice", name: "Новичок", min: 0, note: "Первые прогнозы" },
  { key: "fan", name: "Болельщик", min: 100, note: "Освоил основы" },
  { key: "expert", name: "Знаток", min: 500, note: "Разбирается в игре" },
  { key: "master", name: "Мастер", min: 2000, note: "Один из лучших" },
  { key: "legend", name: "Легенда", min: 5000, note: "Высший уровень" },
];

// +1 for every pick on a game that was played, +10 for the right winner, +10 more when the winner was the underdog by the Winline
// odds at the start, +5 more when fewer than 30% of the fans (out of at least 10) picked it.
export const XP_RULES = { vote: 1, correct: 10, underdog: 10, minority: 5 };
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

const DAY_MS = 86400000;

export function levelOf(value) {
  const xp = Math.max(0, Math.floor(Number(value) || 0));
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i].min) index = i;
  const current = LEVELS[index];
  const next = LEVELS[index + 1] || null;
  const progress = next ? (xp - current.min) / (next.min - current.min) : 1;
  return {
    key: current.key, name: current.name, note: current.note, min: current.min, xp,
    next: next ? { key: next.key, name: next.name, min: next.min } : null,
    to_next: next ? next.min - xp : 0,
    progress: Math.max(0, Math.min(1, progress)),
  };
}

// The game day of the NHL: the same as date(datetime(scheduled_start_utc,'-8 hours')) in the SQL of the other layers.
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

// The morning message of the bot. rows: the settled picks not told yet; levelXp: all the points of the person.
export function digestText(rows, { levelXp = 0, noSpoilers = false } = {}) {
  const played = (rows || []).filter((r) => r.result === "win" || r.result === "loss");
  if (!played.length) return null;
  if (noSpoilers) return "🏒 Ваши прогнозы рассчитаны.\nВключён режим без спойлеров — итоги и очки смотрите в приложении.";
  const lines = played.map((r) => `${r.result === "win" ? "✅" : "❌"} ${r.away_tri} — ${r.home_tri}: вы выбрали ${r.pick_tri} · +${r.xp} XP`);
  const correct = played.filter((r) => r.result === "win").length;
  const xp = played.reduce((sum, r) => sum + (Number(r.xp) || 0), 0);
  const level = levelOf(levelXp);
  const next = level.next ? `, до уровня «${level.next.name}»: ${formatXp(level.to_next)} XP` : "";
  return `🏒 Итоги ваших прогнозов\n\n${lines.join("\n")}\n\nУгадано ${correct} из ${played.length} · +${xp} XP\nУровень: ${level.name} — ${formatXp(level.xp)} XP${next}`;
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
