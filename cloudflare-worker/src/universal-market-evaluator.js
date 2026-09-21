import { withDemoOdds } from "./demo-winline-odds.js";
import { applyTeamGrammar, lastGamesPhrase } from "./team-russian-grammar.js";

const HISTORY_LIMIT = 200;
const STANDARD_WINDOWS = [5, 10, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200];
const GAME_TOTAL_LINES = [4.5, 5.5, 6.5, 7.5];
const TEAM_TOTAL_LINES = [1.5, 2.5, 3.5, 4.5];
const HANDICAP_LINES = [-2.5, -1.5, 1.5, 2.5];

function minimumRate(window) {
  if (window <= 5) return 0.80;
  if (window <= 10) return 0.70;
  return 0.65;
}

function trendWindows(maxRows) {
  const n = Math.min(HISTORY_LIMIT, Math.max(0, Number(maxRows) || 0));
  const windows = STANDARD_WINDOWS.filter((w) => w <= n);
  if (n >= 20 && !windows.includes(n)) windows.push(n);
  return [...new Set(windows)].sort((a, b) => a - b);
}

export async function buildUniversalMarketInsights(db, game) {
  if (!db || !game?.game_pk || !game?.scheduled_start_utc) return [];

  const [awayR, homeR] = await db.batch([
    recentRowsStatement(db, game.away_tri, game.scheduled_start_utc),
    recentRowsStatement(db, game.home_tri, game.scheduled_start_utc),
  ]);

  return evaluateUniversalMarketRows(game, {
    [game.away_tri]: awayR.results || [],
    [game.home_tri]: homeR.results || [],
  });
}

export function evaluateUniversalMarketRows(game, rowsByTeam) {
  const away = game.away_tri;
  const home = game.home_tri;
  const awayRows = rowsByTeam?.[away] || [];
  const homeRows = rowsByTeam?.[home] || [];
  if (!awayRows.length || !homeRows.length) return [];

  const candidates = [];
  candidates.push(...evaluateGameTotals(game, awayRows, homeRows));
  candidates.push(...evaluateTeamTotals(game, away, home, awayRows, homeRows));
  candidates.push(...evaluateTeamTotals(game, home, away, homeRows, awayRows));
  candidates.push(...evaluateHandicaps(game, away, awayRows));
  candidates.push(...evaluateHandicaps(game, home, homeRows));

  return selectPortfolio(candidates);
}

function recentRowsStatement(db, team, before) {
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,opponent_tri,is_home,
           final_goals_for,final_goals_against,total_goals,final_goal_diff,final_win,
           regulation_goals_for,regulation_goals_against,
           p1_goals_for,p1_goals_against,p2_goals_for,p2_goals_against,p3_goals_for,p3_goals_against,
           shots_for,shots_against,corsi_for_pct,fenwick_for_pct,rest_days,is_back_to_back
    FROM team_game_features
    WHERE team_tri=? AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT ${HISTORY_LIMIT};
  `).bind(team, before);
}

function evaluateGameTotals(game, awayRows, homeRows) {
  const out = [];
  for (const window of trendWindows(Math.min(awayRows.length, homeRows.length))) {
    const awaySample = awayRows.slice(0, window);
    const homeSample = homeRows.slice(0, window);
    if (awaySample.length < window || homeSample.length < window) continue;

    for (const line of GAME_TOTAL_LINES) {
      for (const side of ["over", "under"]) {
        const predicate = side === "over"
          ? (r) => Number(r.total_goals) > line
          : (r) => Number(r.total_goals) < line;
        const a = rateStats(awaySample, predicate);
        const h = rateStats(homeSample, predicate);
        const threshold = minimumRate(window);
        const averageRate = (a.rate + h.rate) / 2;
        const floor = threshold - 0.05;
        if (a.rate < floor || h.rate < floor || averageRate < threshold) continue;

        const avgTotalAway = average(awaySample, "total_goals");
        const avgTotalHome = average(homeSample, "total_goals");
        const score = confluenceScore(a, h, window) + lineUtilityBonus("game_total", line);
        const sideLabel = side === "over" ? "ТБ" : "ТМ";
        out.push(marketCard({
          game,
          type: `market_game_total_${side}_${lineKey(line)}_w${window}`,
          score,
          eyebrow: `ТОТАЛ МАТЧА · ${line}`,
          value: `${a.hits}/${window} + ${h.hits}/${window}`,
          title: `В матчах ${game.away_tri} ${sideLabel} ${line} прошёл ${a.hits}/${window}, у ${game.home_tri} — ${h.hits}/${window}`,
          explanation: `Два независимых командных среза по одинаковой линии. Средний тотал: ${avgTotalAway.toFixed(1)} у ${game.away_tri} и ${avgTotalHome.toFixed(1)} у ${game.home_tri}.`,
          evidence: {
            window,
            line,
            side,
            away: evidenceStats(a, awaySample),
            home: evidenceStats(h, homeSample),
            average_rate: averageRate,
            average_total_away: avgTotalAway,
            average_total_home: avgTotalHome,
          },
          market: {
            type: "game_total",
            subject: null,
            side,
            line,
            label: `${sideLabel} ${line}`,
          },
        }));
      }
    }
  }
  return out;
}

function evaluateTeamTotals(game, team, opponent, teamRows, oppRows) {
  const out = [];
  for (const window of trendWindows(teamRows.length)) {
    const teamSample = teamRows.slice(0, window);
    const oppSample = oppRows.slice(0, window);
    if (teamSample.length < window) continue;

    for (const line of TEAM_TOTAL_LINES) {
      for (const side of ["over", "under"]) {
        const teamPredicate = side === "over"
          ? (r) => Number(r.final_goals_for) > line
          : (r) => Number(r.final_goals_for) < line;
        const attack = rateStats(teamSample, teamPredicate);
        const threshold = minimumRate(window);

        if (attack.rate >= threshold) {
          const score = singleTrendScore(attack, window) + lineUtilityBonus("team_total", line);
          const sideLabel = side === "over" ? "ИТБ" : "ИТМ";
          out.push(marketCard({
            game,
            type: `market_team_total_${team}_${side}_${lineKey(line)}_w${window}`,
            score,
            eyebrow: `${team} · КОМАНДНЫЙ ТОТАЛ ${line}`,
            value: `${attack.hits}/${window}`,
            title: `${team} ${side === "over" ? `забил ${Math.floor(line) + 1}+` : `остался ниже ${line}`} ${trendHitText(attack, window)}`,
            explanation: `Rolling hit-rate по окну ${window}. Выбор окна штрафуется за маленькую выборку, поэтому 5 матчей не вытесняют более длинный устойчивый тренд без преимущества.`,
            evidence: {
              window,
              line,
              side,
              attack: evidenceStats(attack, teamSample),
              average_goals_for: average(teamSample, "final_goals_for"),
            },
            market: {
              type: "team_total",
              subject: team,
              side,
              line,
              label: `${team} ${sideLabel} ${line}`,
            },
          }));
        }

        if (oppSample.length < window) continue;
        const oppPredicate = side === "over"
          ? (r) => Number(r.final_goals_against) > line
          : (r) => Number(r.final_goals_against) < line;
        const defense = rateStats(oppSample, oppPredicate);
        const averageRate = (attack.rate + defense.rate) / 2;
        const floor = threshold - 0.05;
        if (attack.rate < floor || defense.rate < floor || averageRate < threshold) continue;

        const sideLabel = side === "over" ? "ИТБ" : "ИТМ";
        out.push(marketCard({
          game,
          type: `market_team_total_confluence_${team}_${side}_${lineKey(line)}_w${window}`,
          score: confluenceScore(attack, defense, window) + 7 + lineUtilityBonus("team_total", line),
          eyebrow: `СОВПАДЕНИЕ ТРЕНДОВ · ${team}`,
          value: `${attack.hits}/${window} + ${defense.hits}/${window}`,
          title: teamTotalConfluenceTitle(team, opponent, side, line, attack.hits, defense.hits, window),
          explanation: `Совпали собственный голевой тренд ${team} и то, сколько пропускает ${opponent}, на одной и той же линии.`,
          evidence: {
            window,
            line,
            side,
            attack: evidenceStats(attack, teamSample),
            opponent_defense: evidenceStats(defense, oppSample),
            average_rate: averageRate,
            team_avg_goals_for: average(teamSample, "final_goals_for"),
            opponent_avg_goals_against: average(oppSample, "final_goals_against"),
          },
          market: {
            type: "team_total",
            subject: team,
            side,
            line,
            label: `${team} ${sideLabel} ${line}`,
          },
        }));
      }
    }
  }
  return out;
}

function teamTotalConfluenceTitle(team, opponent, side, line, attackHits, defenseHits, window) {
  const threshold = Math.floor(Number(line)) + 1;
  if (side === "over") {
    return `${team} забивал ${threshold}+ гола в ${attackHits} из ${lastGamesPhrase(window)}; ${opponent} пропускал ${threshold}+ гола в ${defenseHits} из ${lastGamesPhrase(window)}`;
  }
  const maxGoals = Math.floor(Number(line));
  return `${team} забивал не больше ${maxGoals} гола в ${attackHits} из ${lastGamesPhrase(window)}; ${opponent} пропускал не больше ${maxGoals} гола в ${defenseHits} из ${lastGamesPhrase(window)}`;
}

function evaluateHandicaps(game, team, rows) {
  const out = [];
  for (const window of trendWindows(rows.length)) {
    const sample = rows.slice(0, window);
    if (sample.length < window) continue;
    const threshold = minimumRate(window);

    for (const line of HANDICAP_LINES) {
      const stat = rateStats(sample, (r) => Number(r.final_goal_diff) + line > 0);
      if (stat.rate < threshold) continue;
      out.push(marketCard({
        game,
        type: `market_handicap_${team}_${handicapKey(line)}_w${window}`,
        score: singleTrendScore(stat, window) + handicapUtilityBonus(line),
        eyebrow: `${team} · ФОРА ${signedLine(line)}`,
        value: `${stat.hits}/${window}`,
        title: `${team} закрыл фору ${signedLine(line)} ${trendHitText(stat, window)}`,
        explanation: `Фора оценивается по фактической финальной разнице шайб. Для ${signedLine(line)} условие: разница ${team} + (${signedLine(line)}) > 0.`,
        evidence: {
          window,
          line,
          cover: evidenceStats(stat, sample),
          average_goal_diff: average(sample, "final_goal_diff"),
        },
        market: {
          type: "handicap",
          subject: team,
          side: team,
          line,
          label: `${team} ${signedLine(line)}`,
        },
      }));
    }
  }
  return out;
}

function selectPortfolio(candidates) {
  const bestExact = new Map();
  for (const card of candidates) {
    const key = `${card.market.type}:${card.market.subject || "all"}:${card.market.side}:${card.market.line}`;
    const current = bestExact.get(key);
    if (
      !current ||
      card.score > current.score ||
      (card.score === current.score && Number(card.evidence?.window || 0) > Number(current.evidence?.window || 0))
    ) bestExact.set(key, card);
  }

  const sorted = [...bestExact.values()].sort((a, b) => b.score - a.score);
  const selected = [];
  const limits = new Map();

  for (const card of sorted) {
    let bucket;
    let max;
    if (card.market.type === "game_total") {
      bucket = "game_total";
      max = 1;
    } else if (card.market.type === "team_total") {
      bucket = `team_total:${card.market.subject}`;
      max = 1;
    } else if (card.market.type === "handicap") {
      bucket = `handicap:${card.market.subject}`;
      max = 1;
    } else {
      bucket = card.market.type;
      max = 1;
    }

    const used = limits.get(bucket) || 0;
    if (used >= max) continue;
    selected.push(card);
    limits.set(bucket, used + 1);
    if (selected.length >= 8) break;
  }

  return selected;
}

function marketCard({ game, type, score, eyebrow, value, title, explanation, evidence, market }) {
  const id = `${game.game_pk}:market-evaluator:${type}`;
  const pricedMarket = withDemoOdds(market, id);
  return {
    id,
    insight_type: type,
    category: "market_evaluator",
    kind: "history",
    timing: "pregame",
    score: Math.round(Math.max(0, Math.min(100, score))),
    eyebrow,
    value,
    title: applyTeamGrammar(title),
    explanation,
    evidence: {
      ...evidence,
      feature_layer: "team_game_features_v2_market_evaluator",
      selection_policy: "dynamic_windows_up_to_200_with_current_streak",
    },
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    market: pricedMarket,
  };
}

function rateStats(rows, predicate) {
  let hits = 0;
  let streak = 0;
  let streakOpen = true;
  for (const row of rows) {
    const hit = Boolean(predicate(row));
    if (hit) hits += 1;
    if (streakOpen && hit) streak += 1;
    else streakOpen = false;
  }
  const n = rows.length;
  return {
    hits,
    n,
    streak,
    rate: n ? hits / n : 0,
    wilson90: wilsonLower(hits, n, 1.6448536269514722),
  };
}

function trendHitText(stat, window) {
  if (Number(stat?.streak || 0) >= 20) return `в ${stat.streak} матчах подряд`;
  return `в ${stat.hits} из ${lastGamesPhrase(window)}`;
}

function evidenceStats(stat, rows) {
  return {
    hits: stat.hits,
    sample: stat.n,
    hit_rate: stat.rate,
    current_streak: stat.streak,
    wilson90_lower: stat.wilson90,
    game_pks: rows.map((r) => Number(r.game_pk)),
  };
}

function sampleBonus(window) {
  if (window <= 5) return 1;
  if (window <= 10) return 4;
  return Math.min(13, 7 + Math.max(0, Math.log2(window / 20)) * 3);
}

function singleTrendScore(stat, window) {
  return 54 + stat.rate * 18 + stat.wilson90 * 10 + sampleBonus(window);
}

function confluenceScore(a, b, window) {
  const averageRate = (a.rate + b.rate) / 2;
  const averageLower = (a.wilson90 + b.wilson90) / 2;
  return 53 + averageRate * 18 + averageLower * 9 + sampleBonus(window);
}

function wilsonLower(hits, n, z) {
  if (!n) return 0;
  const p = hits / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denominator);
}

function lineUtilityBonus(type, line) {
  if (type === "game_total") {
    if (line === 5.5 || line === 6.5) return 3;
    return 0;
  }
  if (type === "team_total") {
    if (line === 2.5 || line === 3.5) return 3;
    return 0;
  }
  return 0;
}

function handicapUtilityBonus(line) {
  return Math.abs(line) === 1.5 ? 3 : 0;
}

function average(rows, key) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length;
}

function lineKey(line) {
  return String(line).replace(".", "_");
}

function handicapKey(line) {
  return `${line < 0 ? "m" : "p"}${lineKey(Math.abs(line))}`;
}

function signedLine(line) {
  return `${line > 0 ? "+" : ""}${line.toFixed(1)}`;
}
