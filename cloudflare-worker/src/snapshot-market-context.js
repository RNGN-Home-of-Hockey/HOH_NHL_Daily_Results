import { withDemoOdds } from "./demo-winline-odds.js";

const WINDOWS = [5, 10, 20];
const MIN_LEAGUE_TEAMS = 28;

export async function buildSnapshotMarketContextInsights(db, game) {
  if (!db || !game?.game_pk || !game?.away_tri || !game?.home_tri) return [];
  const result = await db.prepare(`
    SELECT *
    FROM pregame_team_snapshots
    WHERE game_pk=? AND team_tri IN (?,?)
    ORDER BY window_games DESC,team_tri;
  `).bind(game.game_pk, game.away_tri, game.home_tri).all();
  return evaluateSnapshotMarketContext(game, result.results || []);
}

export function evaluateSnapshotMarketContext(game, rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const byKey = new Map(rows.map((row) => [`${row.team_tri}:${Number(row.window_games)}`, row]));
  const candidates = [];

  for (const window of WINDOWS) {
    for (const team of [game.away_tri, game.home_tri]) {
      const opponent = team === game.home_tri ? game.away_tri : game.home_tri;
      const row = byKey.get(`${team}:${window}`);
      const opp = byKey.get(`${opponent}:${window}`);
      if (!row) continue;
      candidates.push(...leagueRankCards(game, row, window));
      if (opp) {
        const advanced = advancedContextCard(game, row, opp, window);
        if (advanced) candidates.push(advanced);
      }
    }
  }

  return selectSnapshotPortfolio(candidates);
}

function leagueRankCards(game, row, window) {
  const totalTeams = Number(row.league_teams || 0);
  if (Number(row.sample_size || 0) < window || totalTeams < MIN_LEAGUE_TEAMS) return [];
  const team = row.team_tri;
  const opponent = row.opponent_tri;
  const metrics = [
    { rank: "rank_gf", value: "gf_pg", family: "scoring", label: "голам за матч", higherIsStrong: true },
    { rank: "rank_ga", value: "ga_pg", family: "defense", label: "пропущенным за матч", higherIsStrong: false },
    { rank: "rank_goal_diff", value: "goal_diff_pg", family: "goal_diff", label: "разнице шайб", higherIsStrong: true },
    { rank: "rank_total", value: "total_pg", family: "total", label: "тоталу матчей", higherIsStrong: true },
    { rank: "rank_corsi", value: "corsi_pct", family: "possession", label: "Corsi", higherIsStrong: true },
    { rank: "rank_fenwick", value: "fenwick_pct", family: "possession", label: "Fenwick", higherIsStrong: true },
    { rank: "rank_p2_diff", value: "p2_diff_pg", family: "period2", label: "разнице шайб во 2-м периоде", higherIsStrong: true },
  ];
  const cards = [];
  for (const metric of metrics) {
    const rank = Number(row[metric.rank]);
    if (!Number.isFinite(rank)) continue;
    const bottom = rank >= totalTeams - 2;
    if (!(rank <= 3 || bottom)) continue;
    const market = marketForRank(game, team, opponent, metric.family, bottom);
    const id = `${game.game_pk}:snapshot-rank:${metric.family}:${team}:w${window}:${bottom ? "bottom" : "top"}`;
    const priced = withDemoOdds(market, id);
    const raw = Number(row[metric.value]);
    const value = formatMetric(metric.value, raw);
    cards.push({
      id,
      insight_type: `snapshot_rank_${metric.family}_${bottom ? "bottom" : "top"}_w${window}`,
      category: "league_rank",
      kind: "history",
      timing: "pregame",
      score: rankScore(window, rank, totalTeams),
      eyebrow: `ПОСЛЕДНИЕ ${window} · ЛИГА`,
      value: bottom ? `#${rank} из ${totalTeams}` : `#${rank} в НХЛ`,
      title: `${team} — #${rank} по ${metric.label}: ${value}`,
      explanation: `Предрасчитанный pregame snapshot: ранг вычислен только по матчам, завершённым до старта этой игры.`,
      evidence: {
        window,
        rank,
        league_teams: totalTeams,
        metric: metric.value,
        metric_value: raw,
        feature_layer: "pregame_team_snapshots_v1",
      },
      note: `${priced.label} · WINLINE · ДЕМО-КЭФ ${priced.odds.toFixed(2)} · промокод HOH`,
      market: priced,
    });
  }
  return cards;
}

function advancedContextCard(game, teamRow, oppRow, window) {
  const totalTeams = Number(teamRow.advanced_league_teams || 0);
  const oppTotal = Number(oppRow.advanced_league_teams || 0);
  if (
    Number(teamRow.advanced_sample_size || 0) < window ||
    Number(oppRow.advanced_sample_size || 0) < window ||
    totalTeams < MIN_LEAGUE_TEAMS || oppTotal < MIN_LEAGUE_TEAMS
  ) return null;

  const team = teamRow.team_tri;
  const opponent = oppRow.team_tri;
  const attackRanks = [
    Number(teamRow.rank_xgf_pct_5v5),
    Number(teamRow.rank_xgf60_5v5),
    Number(teamRow.rank_corsi_pct_5v5),
    Number(teamRow.rank_fenwick_pct_5v5),
  ].filter(Number.isFinite);
  if (!attackRanks.length) return null;
  const attackTop5 = attackRanks.filter((rank) => rank <= 5).length;
  const attackTop3 = attackRanks.filter((rank) => rank <= 3).length;
  const attackBottom5 = attackRanks.filter((rank) => rank >= totalTeams - 4).length;
  const attackBottom3 = attackRanks.filter((rank) => rank >= totalTeams - 2).length;
  const oppXgaRank = Number(oppRow.rank_xga60_5v5);
  if (!Number.isFinite(oppXgaRank)) return null;
  const weakDefense = oppXgaRank >= oppTotal - 4;
  const veryWeakDefense = oppXgaRank >= oppTotal - 2;
  const strongDefense = oppXgaRank <= 5;
  const eliteDefense = oppXgaRank <= 3;

  let side = null;
  let reason = null;
  if ((attackTop5 >= 2 && weakDefense) || (attackTop3 >= 2 && veryWeakDefense)) {
    side = "over";
    reason = "strong_attack_vs_weak_defense";
  } else if ((attackBottom5 >= 2 && strongDefense) || (attackBottom3 >= 2 && eliteDefense)) {
    side = "under";
    reason = "weak_attack_vs_strong_defense";
  } else {
    return null;
  }

  const market = {
    type: "team_total",
    period: "GAME",
    subject: team,
    side,
    line: 2.5,
    label: `${team} ${side === "over" ? "ИТБ" : "ИТМ"} 2.5`,
  };
  const id = `${game.game_pk}:snapshot-advanced:${team}:${side}:w${window}`;
  const priced = withDemoOdds(market, id);
  const xgfRank = Number(teamRow.rank_xgf_pct_5v5);
  const xgf60Rank = Number(teamRow.rank_xgf60_5v5);
  const title = `${team}: xGF% #${xgfRank}, xGF/60 #${xgf60Rank}; ${opponent} xGA/60 #${oppXgaRank}`;
  return {
    id,
    insight_type: `snapshot_advanced_${reason}_${team}_w${window}`,
    category: "advanced_context",
    kind: "history",
    timing: "pregame",
    score: advancedScore(window, side === "over" ? attackTop3 : attackBottom3, side === "over" ? veryWeakDefense : eliteDefense),
    eyebrow: `5×5 SNAPSHOT · ${window}`,
    value: `${Number(teamRow.xgf_pct_5v5 || 0).toFixed(1)}% xGF`,
    title,
    explanation: `5×5-контекст предрасчитан локально до старта матча и читается из D1 одной компактной snapshot-строкой.`,
    evidence: {
      window,
      reason,
      team: {
        xgf_pct: teamRow.xgf_pct_5v5,
        xgf60: teamRow.xgf60_5v5,
        corsi_pct: teamRow.corsi_pct_5v5,
        fenwick_pct: teamRow.fenwick_pct_5v5,
        pdo: teamRow.pdo_5v5,
        gsax: teamRow.gsax_5v5,
        ranks: {
          xgf_pct: teamRow.rank_xgf_pct_5v5,
          xgf60: teamRow.rank_xgf60_5v5,
          corsi: teamRow.rank_corsi_pct_5v5,
          fenwick: teamRow.rank_fenwick_pct_5v5,
        },
      },
      opponent: {
        xga60: oppRow.xga60_5v5,
        rank_xga60: oppXgaRank,
      },
      feature_layer: "pregame_team_snapshots_v1_advanced",
    },
    note: `${priced.label} · WINLINE · ДЕМО-КЭФ ${priced.odds.toFixed(2)} · промокод HOH`,
    market: priced,
  };
}

function marketForRank(game, team, opponent, family, bottom) {
  if (family === "scoring") {
    return { type: "team_total", period: "GAME", subject: team, side: bottom ? "under" : "over", line: 2.5, label: `${team} ${bottom ? "ИТМ" : "ИТБ"} 2.5` };
  }
  if (family === "defense") {
    return { type: "team_total", period: "GAME", subject: opponent, side: bottom ? "over" : "under", line: 2.5, label: `${opponent} ${bottom ? "ИТБ" : "ИТМ"} 2.5` };
  }
  if (family === "total") {
    return { type: "game_total", period: "GAME", subject: null, side: bottom ? "under" : "over", line: 5.5, label: `${bottom ? "ТМ" : "ТБ"} 5.5` };
  }
  if (family === "period2") {
    const subject = bottom ? opponent : team;
    return { type: "period_2_result", period: "P2", subject, side: subject, label: `2-й период — ${subject}` };
  }
  if (family === "goal_diff" || family === "possession") {
    const subject = bottom ? opponent : team;
    return { type: "handicap", period: "GAME", subject, side: subject, line: -1.5, label: `${subject} -1.5` };
  }
  const subject = bottom ? opponent : team;
  return { type: "moneyline", period: "GAME", subject, side: subject, label: `Победа ${subject}` };
}

function selectSnapshotPortfolio(cards) {
  const best = new Map();
  for (const card of cards) {
    const key = `${card.category}:${card.market?.type}:${card.market?.subject || "all"}:${card.market?.side || ""}:${card.market?.line ?? ""}`;
    const current = best.get(key);
    const window = Number(card.evidence?.window || 0);
    const currentWindow = Number(current?.evidence?.window || 0);
    if (!current || Number(card.score || 0) > Number(current.score || 0) || (Number(card.score || 0) === Number(current.score || 0) && window > currentWindow)) {
      best.set(key, card);
    }
  }
  return [...best.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 6);
}

function rankScore(window, rank, totalTeams) {
  const edge = Math.min(rank, totalTeams - rank + 1);
  const rankBonus = edge === 1 ? 9 : edge === 2 ? 6 : 4;
  const sampleBonus = window === 20 ? 12 : window === 10 ? 7 : 2;
  return Math.min(97, 72 + rankBonus + sampleBonus);
}

function advancedScore(window, extremeCount, defenseExtreme) {
  const sampleBonus = window === 20 ? 9 : window === 10 ? 5 : 1;
  return Math.min(98, 78 + sampleBonus + Math.min(6, extremeCount * 2) + (defenseExtreme ? 4 : 0));
}

function formatMetric(key, value) {
  if (!Number.isFinite(value)) return "—";
  if (key === "corsi_pct" || key === "fenwick_pct") return `${value.toFixed(1)}%`;
  if (key === "goal_diff_pg" || key === "p2_diff_pg") return `${value > 0 ? "+" : ""}${value.toFixed(2)} за матч`;
  return `${value.toFixed(2)} за матч`;
}
