import { withDemoOdds } from "./demo-winline-odds.js";

const WINDOWS = [5, 10, 20];
const GAME_TOTAL_LINES = [4.5, 5.5, 6.5];
const TEAM_TOTAL_LINES = [1.5, 2.5, 3.5];
const MIN_RATE_BY_WINDOW = new Map([
  [5, 0.80],
  [10, 0.70],
  [20, 0.65],
]);

export async function buildRegulationMarketInsights(db, game) {
  if (!db || !game?.game_pk || !game?.scheduled_start_utc) return [];
  const [awayR, homeR] = await db.batch([
    recentRegulationRows(db, game.away_tri, game.scheduled_start_utc),
    recentRegulationRows(db, game.home_tri, game.scheduled_start_utc),
  ]);
  return evaluateRegulationMarketRows(game, {
    [game.away_tri]: awayR.results || [],
    [game.home_tri]: homeR.results || [],
  });
}

export function evaluateRegulationMarketRows(game, rowsByTeam) {
  const awayRows = rowsByTeam?.[game.away_tri] || [];
  const homeRows = rowsByTeam?.[game.home_tri] || [];
  if (!awayRows.length || !homeRows.length) return [];

  const candidates = [
    ...evaluateRegulationGameTotals(game, awayRows, homeRows),
    ...evaluateRegulationTeamTotals(game, game.away_tri, game.home_tri, awayRows, homeRows),
    ...evaluateRegulationTeamTotals(game, game.home_tri, game.away_tri, homeRows, awayRows),
  ];
  return selectPortfolio(candidates);
}

function recentRegulationRows(db, team, before) {
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,opponent_tri,is_home,
           regulation_goals_for,regulation_goals_against,
           regulation_goals_for + regulation_goals_against AS regulation_total,
           regulation_goal_diff,regulation_result
    FROM team_game_features
    WHERE team_tri=? AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT 20;
  `).bind(team, before);
}

function evaluateRegulationGameTotals(game, awayRows, homeRows) {
  const out = [];
  for (const window of WINDOWS) {
    const away = awayRows.slice(0, window);
    const home = homeRows.slice(0, window);
    if (away.length < window || home.length < window) continue;
    const threshold = MIN_RATE_BY_WINDOW.get(window);

    for (const line of GAME_TOTAL_LINES) {
      for (const side of ["over", "under"]) {
        const predicate = side === "over"
          ? (r) => Number(r.regulation_total) > line
          : (r) => Number(r.regulation_total) < line;
        const a = rateStats(away, predicate);
        const h = rateStats(home, predicate);
        const averageRate = (a.rate + h.rate) / 2;
        if (a.rate < threshold - 0.05 || h.rate < threshold - 0.05 || averageRate < threshold) continue;

        out.push(regulationCard({
          game,
          type: `reg_game_total_${side}_${lineKey(line)}_w${window}`,
          score: confluenceScore(a, h, window) + centralLineBonus("game_total", line),
          eyebrow: `60 МИНУТ · ТОТАЛ ${line}`,
          value: `${a.hits}/${window} + ${h.hits}/${window}`,
          title: `За 60 минут ${side === "over" ? "ТБ" : "ТМ"} ${line}: матчи ${game.away_tri} — ${a.hits}/${window}, ${game.home_tri} — ${h.hits}/${window}`,
          explanation: "Считаются только голы в первых трёх периодах. Овертайм и буллиты полностью исключены из выборки.",
          evidence: {
            window,
            settlement: "REG_60_MINUTES",
            line,
            side,
            away: evidenceStats(a, away),
            home: evidenceStats(h, home),
            average_rate: averageRate,
          },
          market: {
            type: "game_total",
            period: "REG",
            subject: null,
            side,
            line,
            label: `60 мин · ${side === "over" ? "ТБ" : "ТМ"} ${line}`,
          },
        }));
      }
    }
  }
  return out;
}

function evaluateRegulationTeamTotals(game, team, opponent, teamRows, opponentRows) {
  const out = [];
  for (const window of WINDOWS) {
    const teamSample = teamRows.slice(0, window);
    const oppSample = opponentRows.slice(0, window);
    if (teamSample.length < window) continue;
    const threshold = MIN_RATE_BY_WINDOW.get(window);

    for (const line of TEAM_TOTAL_LINES) {
      for (const side of ["over", "under"]) {
        const attackPredicate = side === "over"
          ? (r) => Number(r.regulation_goals_for) > line
          : (r) => Number(r.regulation_goals_for) < line;
        const attack = rateStats(teamSample, attackPredicate);

        if (attack.rate >= threshold) {
          out.push(regulationCard({
            game,
            type: `reg_team_total_${team}_${side}_${lineKey(line)}_w${window}`,
            score: singleScore(attack, window) + centralLineBonus("team_total", line),
            eyebrow: `60 МИНУТ · ${team} · ИТ ${line}`,
            value: `${attack.hits}/${window}`,
            title: `${team} за 60 минут: ${side === "over" ? "ИТБ" : "ИТМ"} ${line} в ${attack.hits} из последних ${window}`,
            explanation: "Командный тотал рассчитан только по основному времени, без голов/решающего гола после 60:00.",
            evidence: {
              window,
              settlement: "REG_60_MINUTES",
              line,
              side,
              attack: evidenceStats(attack, teamSample),
            },
            market: {
              type: "team_total",
              period: "REG",
              subject: team,
              side,
              line,
              label: `60 мин · ${team} ${side === "over" ? "ИТБ" : "ИТМ"} ${line}`,
            },
          }));
        }

        if (oppSample.length < window) continue;
        const defensePredicate = side === "over"
          ? (r) => Number(r.regulation_goals_against) > line
          : (r) => Number(r.regulation_goals_against) < line;
        const defense = rateStats(oppSample, defensePredicate);
        const averageRate = (attack.rate + defense.rate) / 2;
        if (attack.rate < threshold - 0.05 || defense.rate < threshold - 0.05 || averageRate < threshold) continue;

        out.push(regulationCard({
          game,
          type: `reg_team_total_confluence_${team}_${side}_${lineKey(line)}_w${window}`,
          score: confluenceScore(attack, defense, window) + 6 + centralLineBonus("team_total", line),
          eyebrow: `60 МИНУТ · СОВПАДЕНИЕ ТРЕНДОВ`,
          value: `${attack.hits}/${window} + ${defense.hits}/${window}`,
          title: `${team} ${side === "over" ? "ИТБ" : "ИТМ"} ${line} за 60 минут: ${attack.hits}/${window}; ${opponent} по пропущенным — ${defense.hits}/${window}`,
          explanation: "Совпали атакующий тренд команды и защитный тренд соперника именно в основном времени.",
          evidence: {
            window,
            settlement: "REG_60_MINUTES",
            line,
            side,
            attack: evidenceStats(attack, teamSample),
            opponent_defense: evidenceStats(defense, oppSample),
            average_rate: averageRate,
          },
          market: {
            type: "team_total",
            period: "REG",
            subject: team,
            side,
            line,
            label: `60 мин · ${team} ${side === "over" ? "ИТБ" : "ИТМ"} ${line}`,
          },
        }));
      }
    }
  }
  return out;
}

function regulationCard({ game, type, score, eyebrow, value, title, explanation, evidence, market }) {
  const id = `${game.game_pk}:regulation-market:${type}`;
  const priced = withDemoOdds(market, id);
  return {
    id,
    insight_type: type,
    category: "regulation_market",
    kind: "history",
    timing: "pregame",
    score: Math.round(Math.max(0, Math.min(100, score))),
    eyebrow,
    value,
    title,
    explanation,
    evidence: {
      ...evidence,
      feature_layer: "team_game_features_v2_regulation_market",
      selection_policy: "regulation_only_best_of_5_10_20",
    },
    note: `${priced.label} · WINLINE · ДЕМО-КЭФ ${priced.odds.toFixed(2)} · промокод HOH`,
    market: priced,
  };
}

function selectPortfolio(cards) {
  const best = new Map();
  for (const card of cards) {
    const key = `${card.market.type}:${card.market.period}:${card.market.subject || "all"}:${card.market.side}:${card.market.line}`;
    const current = best.get(key);
    if (!current || compareCards(card, current) < 0) best.set(key, card);
  }

  const sorted = [...best.values()].sort(compareCards);
  const selected = [];
  const family = new Set();
  for (const card of sorted) {
    const bucket = `${card.market.type}:${card.market.period}:${card.market.subject || "all"}`;
    if (family.has(bucket)) continue;
    family.add(bucket);
    selected.push(card);
    if (selected.length >= 3) break;
  }
  return selected;
}

function compareCards(a, b) {
  const score = Number(b.score || 0) - Number(a.score || 0);
  if (score) return score;
  return Number(b.evidence?.window || 0) - Number(a.evidence?.window || 0);
}

function rateStats(rows, predicate) {
  const hits = rows.reduce((sum, row) => sum + (predicate(row) ? 1 : 0), 0);
  const n = rows.length;
  return { hits, n, rate: n ? hits / n : 0, wilson90: wilsonLower(hits, n) };
}

function evidenceStats(stat, rows) {
  return {
    hits: stat.hits,
    sample: stat.n,
    hit_rate: stat.rate,
    wilson90_lower: stat.wilson90,
    game_pks: rows.map((r) => Number(r.game_pk)),
  };
}

function singleScore(stat, window) {
  return 54 + stat.rate * 18 + stat.wilson90 * 10 + sampleBonus(window);
}

function confluenceScore(a, b, window) {
  return 53 + ((a.rate + b.rate) / 2) * 18 + ((a.wilson90 + b.wilson90) / 2) * 9 + sampleBonus(window);
}

function sampleBonus(window) {
  return window === 20 ? 7 : window === 10 ? 4 : 1;
}

function centralLineBonus(type, line) {
  if (type === "game_total" && (line === 5.5 || line === 6.5)) return 3;
  if (type === "team_total" && (line === 2.5 || line === 3.5)) return 3;
  return 0;
}

function wilsonLower(hits, n) {
  if (!n) return 0;
  const z = 1.6448536269514722;
  const p = hits / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denominator);
}

function lineKey(line) {
  return String(line).replace(".", "_");
}
