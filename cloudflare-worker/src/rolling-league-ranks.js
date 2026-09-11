import { withDemoOdds } from "./demo-winline-odds.js";

const WINDOWS = [5, 10, 20];
const MIN_TEAMS = 28;

export async function buildRollingLeagueRankInsights(db, game) {
  if (!db || !game?.game_pk || !game?.scheduled_start_utc) return [];
  const result = await db.prepare(`
    SELECT team_tri,game_pk,scheduled_start_utc,final_goals_for,final_goals_against,
           total_goals,final_goal_diff,corsi_for_pct,fenwick_for_pct,
           p2_goals_for,p2_goals_against
    FROM (
      SELECT team_tri,game_pk,scheduled_start_utc,final_goals_for,final_goals_against,
             total_goals,final_goal_diff,corsi_for_pct,fenwick_for_pct,
             p2_goals_for,p2_goals_against,
             ROW_NUMBER() OVER (
               PARTITION BY team_tri
               ORDER BY scheduled_start_utc DESC,game_pk DESC
             ) AS rn
      FROM team_game_features
      WHERE scheduled_start_utc<? AND game_type IN (2,3)
    ) ranked
    WHERE rn<=20
    ORDER BY team_tri,scheduled_start_utc DESC,game_pk DESC;
  `).bind(game.scheduled_start_utc).all();

  return evaluateRollingLeagueRanks(game, result.results || []);
}

export function evaluateRollingLeagueRanks(game, rows) {
  const grouped = groupRows(rows);
  if (grouped.size < MIN_TEAMS) return [];

  const currentTeams = new Set([game.away_tri, game.home_tri]);
  const candidates = [];

  for (const window of WINDOWS) {
    const summaries = buildSummaries(grouped, window);
    if (summaries.length < MIN_TEAMS) continue;

    const metrics = [
      { key: "gf", direction: "desc", family: "scoring", label: "голам за матч" },
      { key: "ga", direction: "asc", family: "defense", label: "пропущенным за матч" },
      { key: "goal_diff", direction: "desc", family: "goal_diff", label: "разнице шайб за матч" },
      { key: "total", direction: "desc", family: "total", label: "среднему тоталу матчей" },
      { key: "corsi", direction: "desc", family: "possession", label: "Corsi" },
      { key: "fenwick", direction: "desc", family: "possession", label: "Fenwick" },
      { key: "p2_diff", direction: "desc", family: "period2", label: "разнице шайб во 2-х периодах" },
    ];

    for (const metric of metrics) {
      const eligible = summaries.filter((row) => Number.isFinite(row[metric.key]));
      if (eligible.length < MIN_TEAMS) continue;
      eligible.sort((a, b) => metric.direction === "asc"
        ? a[metric.key] - b[metric.key]
        : b[metric.key] - a[metric.key]);

      for (const team of currentTeams) {
        const index = eligible.findIndex((row) => row.team_tri === team);
        if (index < 0) continue;
        const rank = index + 1;
        const totalTeams = eligible.length;
        const extreme = rank <= 3 || rank >= totalTeams - 2;
        if (!extreme) continue;
        const summary = eligible[index];
        candidates.push(rankCard(game, summary, metric, window, rank, totalTeams));
      }
    }
  }

  return selectRankPortfolio(candidates);
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
  for (const [team, allRows] of grouped.entries()) {
    const rows = allRows.slice(0, window);
    if (rows.length < window) continue;
    const corsiRows = rows.filter((r) => r.corsi_for_pct !== null && r.corsi_for_pct !== undefined);
    const fenwickRows = rows.filter((r) => r.fenwick_for_pct !== null && r.fenwick_for_pct !== undefined);
    out.push({
      team_tri: team,
      sample: window,
      gf: average(rows, (r) => r.final_goals_for),
      ga: average(rows, (r) => r.final_goals_against),
      goal_diff: average(rows, (r) => r.final_goal_diff),
      total: average(rows, (r) => r.total_goals),
      corsi: corsiRows.length >= Math.ceil(window * 0.8) ? average(corsiRows, (r) => r.corsi_for_pct) : NaN,
      fenwick: fenwickRows.length >= Math.ceil(window * 0.8) ? average(fenwickRows, (r) => r.fenwick_for_pct) : NaN,
      p2_diff: average(rows, (r) => Number(r.p2_goals_for || 0) - Number(r.p2_goals_against || 0)),
      game_pks: rows.map((r) => Number(r.game_pk)),
    });
  }
  return out;
}

function rankCard(game, summary, metric, window, rank, totalTeams) {
  const bottom = rank >= totalTeams - 2;
  const score = rankScore(window, rank, totalTeams);
  const team = summary.team_tri;
  const value = metricValue(summary, metric.key);
  const market = marketForRank(game, team, metric.family, bottom);
  const id = `${game.game_pk}:rolling-rank:${metric.family}:${metric.key}:${team}:w${window}:${bottom ? "bottom" : "top"}`;
  const pricedMarket = withDemoOdds(market, id);
  const rankText = bottom ? `#${rank} из ${totalTeams}` : `#${rank} в НХЛ`;
  return {
    id,
    insight_type: `rolling_rank_${metric.key}_${bottom ? "bottom" : "top"}_w${window}`,
    category: "league_rank",
    kind: "history",
    timing: "pregame",
    score,
    eyebrow: `ПОСЛЕДНИЕ ${window} · ЛИГА`,
    value: rankText,
    title: `${team} — ${rankText} по ${metric.label}: ${value}`,
    explanation: `Ранг среди ${totalTeams} команд по одинаковому rolling-окну ${window}. Маленькие окна получают более низкий приоритет, чем устойчивые 20-матчевые тренды.`,
    evidence: {
      window,
      rank,
      league_teams: totalTeams,
      metric: metric.key,
      metric_value: summary[metric.key],
      game_pks: summary.game_pks,
      feature_layer: "team_game_features_v2_league_ranks",
    },
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    market: pricedMarket,
  };
}

function marketForRank(game, team, family, bottom) {
  const opponent = team === game.home_tri ? game.away_tri : game.home_tri;
  if (family === "scoring") {
    return { type: "team_total", subject: team, side: bottom ? "under" : "over", line: 2.5, label: `${team} ${bottom ? "ИТМ" : "ИТБ"} 2.5` };
  }
  if (family === "defense") {
    return { type: "team_total", subject: opponent, side: bottom ? "under" : "over", line: 2.5, label: `${opponent} ${bottom ? "ИТМ" : "ИТБ"} 2.5` };
  }
  if (family === "total") {
    return { type: "game_total", subject: null, side: bottom ? "under" : "over", line: 5.5, label: `${bottom ? "ТМ" : "ТБ"} 5.5` };
  }
  if (family === "period2") {
    return bottom
      ? { type: "period_2_result", subject: opponent, side: opponent, label: `2-й период — ${opponent}` }
      : { type: "period_2_result", subject: team, side: team, label: `2-й период — ${team}` };
  }
  if (family === "goal_diff" || family === "possession") {
    return bottom
      ? { type: "handicap", subject: opponent, side: opponent, line: -1.5, label: `${opponent} -1.5` }
      : { type: "handicap", subject: team, side: team, line: -1.5, label: `${team} -1.5` };
  }
  return { type: "moneyline", subject: bottom ? opponent : team, side: bottom ? opponent : team, label: `Победа ${bottom ? opponent : team}` };
}

function selectRankPortfolio(cards) {
  const bestByFamilyTeam = new Map();
  for (const card of cards) {
    const key = `${card.evidence.metric}:${card.market.subject || "all"}:${card.market.side || ""}`;
    const current = bestByFamilyTeam.get(key);
    if (
      !current ||
      card.score > current.score ||
      (card.score === current.score && card.evidence.window > current.evidence.window)
    ) bestByFamilyTeam.set(key, card);
  }

  const sorted = [...bestByFamilyTeam.values()].sort((a, b) => b.score - a.score || b.evidence.window - a.evidence.window);
  const selected = [];
  const perTeam = new Map();
  for (const card of sorted) {
    const team = card.market.subject || "game";
    const used = perTeam.get(team) || 0;
    if (used >= 2) continue;
    selected.push(card);
    perTeam.set(team, used + 1);
    if (selected.length >= 4) break;
  }
  return selected;
}

function rankScore(window, rank, totalTeams) {
  const edge = Math.min(rank, totalTeams - rank + 1);
  const rankBonus = edge === 1 ? 9 : edge === 2 ? 6 : 4;
  const sampleBonus = window === 20 ? 12 : window === 10 ? 7 : 2;
  return Math.min(97, 72 + rankBonus + sampleBonus);
}

function metricValue(summary, key) {
  const value = Number(summary[key]);
  if (key === "corsi" || key === "fenwick") return `${value.toFixed(1)}%`;
  if (key === "goal_diff" || key === "p2_diff") return `${value > 0 ? "+" : ""}${value.toFixed(2)} за матч`;
  return `${value.toFixed(2)} за матч`;
}

function average(rows, getter) {
  if (!rows.length) return NaN;
  return rows.reduce((sum, row) => sum + Number(getter(row) || 0), 0) / rows.length;
}
