import { fetchNhlJson } from "./data-core-importer.js";
import { withDemoOdds } from "./demo-winline-odds.js";

const NHL_BASE = "https://api-web.nhle.com/v1";
const SHOT_TYPES = new Set(["shot-on-goal", "goal"]);

export async function buildLiveGameSnapshot(gamePk, fetchImpl = fetch) {
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) {
    throw new Error("game_pk must be a positive integer");
  }

  const payload = await fetchNhlJson(
    fetchImpl,
    `${NHL_BASE}/gamecenter/${gamePk}/play-by-play`,
    { timeoutMs: 12000, maxAttempts: 2 },
  );

  const home = payload.homeTeam || {};
  const away = payload.awayTeam || {};
  const teamsById = new Map([
    [Number(home.id), String(home.abbrev || "").toUpperCase()],
    [Number(away.id), String(away.abbrev || "").toUpperCase()],
  ]);
  const game = {
    game_pk: Number(payload.id || gamePk),
    season_id: String(payload.season || ""),
    game_type: Number(payload.gameType || 0),
    game_state: String(payload.gameState || "").toUpperCase(),
    home_tri: String(home.abbrev || "").toUpperCase(),
    away_tri: String(away.abbrev || "").toUpperCase(),
    home_score: numberOrZero(home.score),
    away_score: numberOrZero(away.score),
    home_sog: nullableNumber(home.sog),
    away_sog: nullableNumber(away.sog),
    period_number: nullableNumber(payload.periodDescriptor?.number),
    period_type: payload.periodDescriptor?.periodType || null,
    time_remaining: payload.clock?.timeRemaining || null,
    seconds_remaining: nullableNumber(payload.clock?.secondsRemaining),
    running: Boolean(payload.clock?.running),
    in_intermission: Boolean(payload.clock?.inIntermission),
  };

  const shots = [];
  for (const play of payload.plays || []) {
    if (!SHOT_TYPES.has(play.typeDescKey)) continue;
    const teamId = Number(play.details?.eventOwnerTeamId);
    const teamTri = teamsById.get(teamId);
    if (!teamTri) continue;
    shots.push({
      sort_order: Number(play.sortOrder ?? play.eventId ?? 0),
      event_type: play.typeDescKey,
      team_tri: teamTri,
      period_number: Number(play.periodDescriptor?.number || 0),
      period_type: play.periodDescriptor?.periodType || null,
      time_in_period: play.timeInPeriod || null,
      elapsed_seconds: gameElapsedSeconds(play),
    });
  }

  const cards = buildLiveCards(game, shots);
  return {
    ok: true,
    source: "nhl_live_play_by_play",
    fetched_at: new Date().toISOString(),
    game,
    shot_events: shots.length,
    cards,
  };
}

export function buildLiveCards(game, shots) {
  if (!game?.home_tri || !game?.away_tri || !Array.isArray(shots)) return [];
  const cards = [];

  addShotWindowCard(cards, game, shots, 20, 14, "ДАВЛЕНИЕ · ПОСЛЕДНИЕ 20", 92);
  addShotWindowCard(cards, game, shots, 10, 8, "РЫВОК · ПОСЛЕДНИЕ 10", 88);
  addRecentMinutesCard(cards, game, shots, 5, 6, 0.72);
  addCurrentPeriodCard(cards, game, shots);
  addUnansweredRunCard(cards, game, shots);

  return dedupe(cards)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 6);
}

function addShotWindowCard(cards, game, shots, windowSize, minLeader, eyebrow, baseScore) {
  if (shots.length < windowSize) return;
  const rows = shots.slice(-windowSize);
  const counts = teamCounts(rows, game);
  const [leader, leaderCount] = leaderEntry(counts);
  const other = opponent(game, leader);
  const otherCount = Number(counts[other] || 0);
  if (leaderCount < minLeader) return;

  cards.push(card({
    game,
    id: `live:${game.game_pk}:sog${windowSize}:${rows.at(-1)?.sort_order || 0}`,
    type: `live_sog_${windowSize}`,
    score: baseScore + Math.min(5, leaderCount - minLeader),
    eyebrow,
    value: `${leaderCount} из ${windowSize}`,
    title: `${leader} нанёс ${leaderCount} из последних ${windowSize} бросков в створ`,
    explanation: `${leaderCount}:${otherCount} по броскам в створ на последнем отрезке. Сигнал давления, а не гарантия следующего гола.`,
    evidence: {
      window_shots: windowSize,
      shots_by_team: counts,
      from_sort_order: rows[0]?.sort_order || null,
      to_sort_order: rows.at(-1)?.sort_order || null,
    },
    market: {
      type: "next_goal_team",
      subject: leader,
      side: leader,
      label: `Следующий гол — ${leader}`,
    },
  }));
}

function addRecentMinutesCard(cards, game, shots, minutes, minShots, minShare) {
  if (shots.length < 2) return;
  const latest = shots.at(-1);
  if (!Number.isFinite(latest?.elapsed_seconds)) return;
  const cutoff = latest.elapsed_seconds - minutes * 60;
  const rows = shots.filter((row) => Number.isFinite(row.elapsed_seconds) && row.elapsed_seconds >= cutoff);
  if (rows.length < minShots) return;

  const counts = teamCounts(rows, game);
  const [leader, leaderCount] = leaderEntry(counts);
  const share = leaderCount / rows.length;
  if (share < minShare) return;
  const other = opponent(game, leader);

  cards.push(card({
    game,
    id: `live:${game.game_pk}:last${minutes}m:${latest.sort_order || 0}`,
    type: "live_recent_minutes_pressure",
    score: 90 + Math.min(5, Math.floor((share - minShare) * 20)),
    eyebrow: `ДАВЛЕНИЕ · ПОСЛЕДНИЕ ${minutes} МИН`,
    value: `${leaderCount}:${Number(counts[other] || 0)}`,
    title: `${leader} заметно перебрасывает соперника на последнем пятиминутном отрезке`,
    explanation: `${leaderCount} из ${rows.length} бросков в створ за последние примерно ${minutes} минут игрового времени принадлежат ${leader}.`,
    evidence: {
      minutes,
      shots_in_window: rows.length,
      shots_by_team: counts,
      share: round3(share),
    },
    market: {
      type: "next_goal_team",
      subject: leader,
      side: leader,
      label: `Следующий гол — ${leader}`,
    },
  }));
}

function addCurrentPeriodCard(cards, game, shots) {
  const period = Number(game.period_number || 0);
  if (!period) return;
  const rows = shots.filter((row) => Number(row.period_number) === period);
  if (rows.length < 12) return;
  const counts = teamCounts(rows, game);
  const [leader, leaderCount] = leaderEntry(counts);
  const share = leaderCount / rows.length;
  if (share < 0.67) return;
  const other = opponent(game, leader);

  cards.push(card({
    game,
    id: `live:${game.game_pk}:period${period}:${rows.at(-1)?.sort_order || 0}`,
    type: "live_period_shot_control",
    score: 84 + Math.min(6, Math.floor((share - 0.67) * 25)),
    eyebrow: `${period}-Й ПЕРИОД · БРОСКИ`,
    value: `${leaderCount}:${Number(counts[other] || 0)}`,
    title: `${leader} контролирует броски в створ в ${period}-м периоде`,
    explanation: `${leaderCount} из ${rows.length} бросков в створ этого периода принадлежат ${leader}.`,
    evidence: {
      period,
      shots_in_period: rows.length,
      shots_by_team: counts,
      share: round3(share),
    },
    market: {
      type: "period_next_goal_team",
      subject: leader,
      side: leader,
      label: `${period}-й период: следующий гол — ${leader}`,
    },
  }));
}

function addUnansweredRunCard(cards, game, shots) {
  if (!shots.length) return;
  const lastTeam = shots.at(-1)?.team_tri;
  if (!lastTeam) return;
  let run = 0;
  for (let i = shots.length - 1; i >= 0; i -= 1) {
    if (shots[i].team_tri !== lastTeam) break;
    run += 1;
  }
  if (run < 6) return;

  cards.push(card({
    game,
    id: `live:${game.game_pk}:run:${shots.at(-1)?.sort_order || 0}`,
    type: "live_unanswered_shot_run",
    score: 86 + Math.min(8, run - 6),
    eyebrow: "БРОСКИ БЕЗ ОТВЕТА",
    value: `${run} подряд`,
    title: `${lastTeam} нанёс ${run} бросков в створ подряд без ответа соперника`,
    explanation: "Короткий live-импульс. Особенно полезен вместе с реальной ценой рынка следующего гола.",
    evidence: {
      unanswered_shots: run,
      last_sort_order: shots.at(-1)?.sort_order || null,
    },
    market: {
      type: "next_goal_team",
      subject: lastTeam,
      side: lastTeam,
      label: `Следующий гол — ${lastTeam}`,
    },
  }));
}

function card({ game, id, type, score, eyebrow, value, title, explanation, evidence, market }) {
  const pricedMarket=withDemoOdds(market,id);
  return {
    id,
    type,
    category: "live",
    kind: "live",
    timing: "live",
    score: Math.round(score),
    eyebrow,
    value,
    title,
    explanation,
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    evidence: {
      ...evidence,
      game_pk: game.game_pk,
      state: game.game_state,
      period: game.period_number,
      time_remaining: game.time_remaining,
      score: `${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}`,
    },
    market: pricedMarket,
  };
}

function teamCounts(rows, game) {
  const counts = {
    [game.away_tri]: 0,
    [game.home_tri]: 0,
  };
  for (const row of rows) {
    if (row.team_tri in counts) counts[row.team_tri] += 1;
  }
  return counts;
}

function leaderEntry(counts) {
  return Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || ["", 0];
}

function opponent(game, team) {
  return team === game.home_tri ? game.away_tri : game.home_tri;
}

function gameElapsedSeconds(play) {
  const period = Number(play.periodDescriptor?.number || 0);
  const periodType = String(play.periodDescriptor?.periodType || "REG");
  const inPeriod = parseClock(play.timeInPeriod);
  if (!period || inPeriod === null) return null;
  if (periodType === "SO") return null;
  const regulationBefore = Math.min(Math.max(period - 1, 0), 3) * 20 * 60;
  if (period <= 3) return regulationBefore + inPeriod;
  const overtimeBefore = 3 * 20 * 60 + Math.max(period - 4, 0) * 20 * 60;
  return overtimeBefore + inPeriod;
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function dedupe(cards) {
  const seen = new Set();
  return cards.filter((item) => {
    const key = `${item.type}:${item.market?.type || ""}:${item.market?.subject || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
