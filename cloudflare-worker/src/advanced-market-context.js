import { withDemoOdds } from "./demo-winline-odds.js";

const WINDOWS = [5, 10, 20];
const MIN_TEAMS = 28;

export async function buildAdvancedMarketContextInsights(db, game) {
  if (!db || !game?.game_pk || !game?.scheduled_start_utc) return [];
  const result = await db.prepare(`
    SELECT team_tri,game_pk,scheduled_start_utc,toi_5v5_minutes,
           xgf_pct_5v5,corsi_for_pct_5v5,fenwick_for_pct_5v5,
           xgf_5v5,xga_5v5,pdo_5v5,goals_saved_above_expected
    FROM (
      SELECT a.team_tri,a.game_pk,g.scheduled_start_utc,a.toi_5v5_minutes,
             a.xgf_pct_5v5,a.corsi_for_pct_5v5,a.fenwick_for_pct_5v5,
             a.xgf_5v5,a.xga_5v5,a.pdo_5v5,a.goals_saved_above_expected,
             ROW_NUMBER() OVER (
               PARTITION BY a.team_tri
               ORDER BY g.scheduled_start_utc DESC,a.game_pk DESC
             ) AS rn
      FROM team_game_advanced_features a
      JOIN games g ON g.game_pk=a.game_pk
      WHERE g.scheduled_start_utc<? AND g.game_type=2
    ) ranked
    WHERE rn<=20
    ORDER BY team_tri,scheduled_start_utc DESC,game_pk DESC;
  `).bind(game.scheduled_start_utc).all();

  return evaluateAdvancedMarketContext(game, result.results || []);
}

export function evaluateAdvancedMarketContext(game, rows) {
  const grouped = groupRows(rows);
  if (grouped.size < MIN_TEAMS) return [];
  const all = [];

  for (const window of WINDOWS) {
    const summaries = buildSummaries(grouped, window);
    if (summaries.length < MIN_TEAMS) continue;
    const ranks = buildRanks(summaries);

    for (const team of [game.away_tri, game.home_tri]) {
      const opponent = team === game.home_tri ? game.away_tri : game.home_tri;
      const teamSummary = summaries.find((row) => row.team_tri === team);
      const oppSummary = summaries.find((row) => row.team_tri === opponent);
      if (!teamSummary || !oppSummary) continue;

      const teamRanks = ranks.get(team);
      const oppRanks = ranks.get(opponent);
      if (!teamRanks || !oppRanks) continue;

      const attackGood = countTop(teamRanks, ["xgf_pct", "corsi_pct", "fenwick_pct", "xgf60"], 5);
      const attackElite = countTop(teamRanks, ["xgf_pct", "corsi_pct", "fenwick_pct", "xgf60"], 3);
      const attackBad = countBottom(teamRanks, ["xgf_pct", "corsi_pct", "fenwick_pct", "xgf60"], teamRanks.totalTeams, 5);
      const attackVeryBad = countBottom(teamRanks, ["xgf_pct", "corsi_pct", "fenwick_pct", "xgf60"], teamRanks.totalTeams, 3);
      const oppDefenseWeak = isBottom(oppRanks.xga60, oppRanks.totalTeams, 5);
      const oppDefenseVeryWeak = isBottom(oppRanks.xga60, oppRanks.totalTeams, 3);
      const oppDefenseStrong = isTop(oppRanks.xga60, 5);
      const oppDefenseElite = isTop(oppRanks.xga60, 3);

      if ((attackGood >= 2 && oppDefenseWeak) || (attackElite >= 2 && oppDefenseVeryWeak)) {
        all.push(contextCard({
          game,
          team,
          opponent,
          window,
          direction: "over",
          score: advancedScore(window, attackElite, oppDefenseVeryWeak, attackGood),
          teamSummary,
          oppSummary,
          teamRanks,
          oppRanks,
          reason: "strong_attack_vs_weak_defense",
        }));
      }

      if ((attackBad >= 2 && oppDefenseStrong) || (attackVeryBad >= 2 && oppDefenseElite)) {
        all.push(contextCard({
          game,
          team,
          opponent,
          window,
          direction: "under",
          score: advancedScore(window, attackVeryBad, oppDefenseElite, attackBad),
          teamSummary,
          oppSummary,
          teamRanks,
          oppRanks,
          reason: "weak_attack_vs_strong_defense",
        }));
      }
    }
  }

  return selectAdvancedPortfolio(all);
}

function groupRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const team = String(row.team_tri || "").trim();
    if (!team) continue;
    if (!grouped.has(team)) grouped.set(team, []);
    grouped.get(team).push(row);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => String(b.scheduled_start_utc || "").localeCompare(String(a.scheduled_start_utc || "")) || Number(b.game_pk) - Number(a.game_pk));
  }
  return grouped;
}

function buildSummaries(grouped, window) {
  const out = [];
  for (const [team, list] of grouped.entries()) {
    const rows = list.slice(0, window);
    if (rows.length < window) continue;
    const validToi = rows.filter((r) => Number(r.toi_5v5_minutes) > 0);
    if (validToi.length < Math.ceil(window * 0.8)) continue;
    const toi = sum(validToi, (r) => r.toi_5v5_minutes);
    const xgf = sum(validToi, (r) => r.xgf_5v5);
    const xga = sum(validToi, (r) => r.xga_5v5);
    out.push({
      team_tri: team,
      window,
      xgf_pct: averageNonNull(rows, "xgf_pct_5v5"),
      corsi_pct: averageNonNull(rows, "corsi_for_pct_5v5"),
      fenwick_pct: averageNonNull(rows, "fenwick_for_pct_5v5"),
      xgf60: toi > 0 ? 60 * xgf / toi : NaN,
      xga60: toi > 0 ? 60 * xga / toi : NaN,
      pdo: averageNonNull(rows, "pdo_5v5"),
      gsax: averageNonNull(rows, "goals_saved_above_expected"),
      game_pks: rows.map((r) => Number(r.game_pk)),
    });
  }
  return out;
}

function buildRanks(summaries) {
  const metrics = {
    xgf_pct: "desc",
    corsi_pct: "desc",
    fenwick_pct: "desc",
    xgf60: "desc",
    xga60: "asc",
  };
  const rankMap = new Map(summaries.map((row) => [row.team_tri, { totalTeams: summaries.length }]));
  for (const [metric, direction] of Object.entries(metrics)) {
    const sorted = summaries
      .filter((row) => Number.isFinite(row[metric]))
      .sort((a, b) => direction === "asc" ? a[metric] - b[metric] : b[metric] - a[metric]);
    sorted.forEach((row, index) => {
      const target = rankMap.get(row.team_tri);
      if (target) target[metric] = index + 1;
    });
  }
  return rankMap;
}

function contextCard({ game, team, opponent, window, direction, score, teamSummary, oppSummary, teamRanks, oppRanks, reason }) {
  const over = direction === "over";
  const market = {
    type: "team_total",
    subject: team,
    side: direction,
    line: 2.5,
    label: `${team} ${over ? "ИТБ" : "ИТМ"} 2.5`,
  };
  const id = `${game.game_pk}:advanced-context:${team}:${direction}:w${window}`;
  const pricedMarket = withDemoOdds(market, id);
  const teamRankText = formatAttackRanks(teamRanks);
  const oppDefenseText = `xGA/60 #${oppRanks.xga60}`;
  return {
    id,
    insight_type: `advanced_${reason}_${team}_w${window}`,
    category: "advanced_context",
    kind: "history",
    timing: "pregame",
    score: Math.round(Math.max(0, Math.min(98, score))),
    eyebrow: `5×5 · ПОСЛЕДНИЕ ${window}`,
    value: `${teamSummary.xgf_pct.toFixed(1)}% xGF`,
    title: over
      ? `${team}: ${teamRankText}; ${opponent} — ${oppDefenseText}`
      : `${team}: слабый 5×5-профиль (${teamRankText}); ${opponent} — ${oppDefenseText}`,
    explanation: over
      ? `Атака ${team} одновременно сильна по нескольким 5×5-метрикам, а ${opponent} находится внизу лиги по xGA/60. Это подтверждающий слой к командному тоталу, а не самостоятельная вероятность.`
      : `У ${team} несколько слабых 5×5-метрик одновременно, а ${opponent} силён по xGA/60. Это подтверждение к нижнему командному тоталу.`,
    evidence: {
      window,
      reason,
      team: advancedEvidence(teamSummary, teamRanks),
      opponent: advancedEvidence(oppSummary, oppRanks),
      feature_layer: "team_game_advanced_features_v1_market_context",
    },
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    market: pricedMarket,
  };
}

function advancedEvidence(summary, ranks) {
  return {
    xgf_pct: summary.xgf_pct,
    corsi_pct: summary.corsi_pct,
    fenwick_pct: summary.fenwick_pct,
    xgf60: summary.xgf60,
    xga60: summary.xga60,
    pdo: summary.pdo,
    gsax: summary.gsax,
    ranks: {
      xgf_pct: ranks.xgf_pct,
      corsi_pct: ranks.corsi_pct,
      fenwick_pct: ranks.fenwick_pct,
      xgf60: ranks.xgf60,
      xga60: ranks.xga60,
      total_teams: ranks.totalTeams,
    },
    game_pks: summary.game_pks,
  };
}

function selectAdvancedPortfolio(cards) {
  const best = new Map();
  for (const card of cards) {
    const key = `${card.market.subject}:${card.market.side}`;
    const current = best.get(key);
    if (
      !current ||
      card.score > current.score ||
      (card.score === current.score && card.evidence.window > current.evidence.window)
    ) best.set(key, card);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 2);
}

function advancedScore(window, eliteCount, defenseExtreme, topFiveCount) {
  const sampleBonus = window === 20 ? 9 : window === 10 ? 5 : 1;
  return 76 + sampleBonus + Math.min(8, eliteCount * 2) + (defenseExtreme ? 4 : 0) + Math.min(4, topFiveCount);
}

function formatAttackRanks(ranks) {
  const parts = [
    ["xGF%", ranks.xgf_pct],
    ["CF%", ranks.corsi_pct],
    ["FF%", ranks.fenwick_pct],
    ["xGF/60", ranks.xgf60],
  ].filter(([, rank]) => Number.isFinite(rank))
   .sort((a, b) => a[1] - b[1])
   .slice(0, 2)
   .map(([name, rank]) => `${name} #${rank}`);
  return parts.join(", ");
}

function countTop(ranks, keys, threshold) {
  return keys.reduce((sum, key) => sum + (isTop(ranks[key], threshold) ? 1 : 0), 0);
}

function countBottom(ranks, keys, totalTeams, threshold) {
  return keys.reduce((sum, key) => sum + (isBottom(ranks[key], totalTeams, threshold) ? 1 : 0), 0);
}

function isTop(rank, threshold) {
  return Number.isFinite(rank) && rank <= threshold;
}

function isBottom(rank, totalTeams, threshold) {
  return Number.isFinite(rank) && rank >= totalTeams - threshold + 1;
}

function averageNonNull(rows, key) {
  const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(rows, getter) {
  return rows.reduce((total, row) => {
    const value = Number(getter(row));
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}
