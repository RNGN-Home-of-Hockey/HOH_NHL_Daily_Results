import { withDemoOdds } from "./demo-winline-odds.js";

const VENUE_WINDOWS = [5, 10, 20];
const VENUE_MIN_RATE = new Map([[5, 0.80], [10, 0.70], [20, 0.65]]);
const H2H_WINDOWS = [4, 6, 10];
const H2H_MIN_RATE = new Map([[4, 0.75], [6, 0.67], [10, 0.60]]);
const GAME_TOTAL_LINES = [4.5, 5.5, 6.5, 7.5];
const TEAM_TOTAL_LINES = [1.5, 2.5, 3.5, 4.5];
const HANDICAP_LINES = [-2.5, -1.5, 1.5, 2.5];

export async function buildMarketSplitInsights(db, game) {
  if (!db || !game?.game_pk || !game?.scheduled_start_utc || !game?.away_tri || !game?.home_tri) return [];

  const [venueR, h2hR] = await db.batch([
    db.prepare(`
      SELECT game_pk,team_tri,opponent_tri,scheduled_start_utc,is_home,
             final_goals_for,final_goals_against,total_goals,final_goal_diff,final_win
      FROM (
        SELECT game_pk,team_tri,opponent_tri,scheduled_start_utc,is_home,
               final_goals_for,final_goals_against,total_goals,final_goal_diff,final_win,
               ROW_NUMBER() OVER (PARTITION BY team_tri ORDER BY scheduled_start_utc DESC,game_pk DESC) AS rn
        FROM team_game_features
        WHERE scheduled_start_utc<?
          AND ((team_tri=? AND is_home=0) OR (team_tri=? AND is_home=1))
      ) ranked
      WHERE rn<=20
      ORDER BY team_tri,scheduled_start_utc DESC,game_pk DESC;
    `).bind(game.scheduled_start_utc, game.away_tri, game.home_tri),
    db.prepare(`
      SELECT game_pk,team_tri,opponent_tri,scheduled_start_utc,is_home,
             final_goals_for,final_goals_against,total_goals,final_goal_diff,final_win
      FROM team_game_features
      WHERE team_tri=? AND opponent_tri=? AND scheduled_start_utc<?
      ORDER BY scheduled_start_utc DESC,game_pk DESC
      LIMIT 10;
    `).bind(game.away_tri, game.home_tri, game.scheduled_start_utc),
  ]);

  const venueRows = venueR.results || [];
  const rowsByTeam = {
    [game.away_tri]: venueRows.filter((r) => r.team_tri === game.away_tri),
    [game.home_tri]: venueRows.filter((r) => r.team_tri === game.home_tri),
  };

  return [
    ...evaluateVenueMarketSplits(game, rowsByTeam),
    ...evaluateH2HMarketSplits(game, h2hR.results || []),
  ];
}

export function evaluateVenueMarketSplits(game, rowsByTeam) {
  const awayRows = rowsByTeam?.[game.away_tri] || [];
  const homeRows = rowsByTeam?.[game.home_tri] || [];
  if (!awayRows.length || !homeRows.length) return [];

  const candidates = [];
  for (const window of VENUE_WINDOWS) {
    const away = awayRows.slice(0, window);
    const home = homeRows.slice(0, window);
    if (away.length < window || home.length < window) continue;
    const threshold = VENUE_MIN_RATE.get(window);

    for (const line of GAME_TOTAL_LINES) {
      for (const side of ["over", "under"]) {
        const pred = side === "over" ? (r) => Number(r.total_goals) > line : (r) => Number(r.total_goals) < line;
        const a = rateStats(away, pred);
        const h = rateStats(home, pred);
        const avg = (a.rate + h.rate) / 2;
        if (a.rate < threshold - 0.05 || h.rate < threshold - 0.05 || avg < threshold) continue;
        candidates.push(splitCard({
          game,
          category: "venue_split",
          type: `venue_game_total_${side}_${lineKey(line)}_w${window}`,
          score: venueConfluenceScore(a, h, window) + utilityBonus("game_total", line),
          eyebrow: `ДОМА/В ГОСТЯХ · ТОТАЛ ${line}`,
          value: `${a.hits}/${window} + ${h.hits}/${window}`,
          title: `${game.away_tri} в гостях и ${game.home_tri} дома: ${side === "over" ? "ТБ" : "ТМ"} ${line} — ${a.hits}/${window} и ${h.hits}/${window}`,
          explanation: `Сравниваются только матчи в той же роли, что и сегодня: ${game.away_tri} — только в гостях, ${game.home_tri} — только дома.`,
          evidence: { window, split: "current_venue", away: evidenceStats(a, away), home: evidenceStats(h, home), average_rate: avg },
          market: { type: "game_total", subject: null, side, line, label: `${side === "over" ? "ТБ" : "ТМ"} ${line}` },
        }));
      }
    }

    candidates.push(...venueTeamCandidates(game, game.away_tri, away, window, threshold, "в гостях"));
    candidates.push(...venueTeamCandidates(game, game.home_tri, home, window, threshold, "дома"));
  }

  return selectSplitPortfolio(candidates, 6);
}

export function evaluateH2HMarketSplits(game, awayPerspectiveRows) {
  if (!Array.isArray(awayPerspectiveRows) || awayPerspectiveRows.length < 4) return [];
  const candidates = [];

  for (const window of H2H_WINDOWS) {
    const sample = awayPerspectiveRows.slice(0, window);
    if (sample.length < window) continue;
    const threshold = H2H_MIN_RATE.get(window);

    for (const line of GAME_TOTAL_LINES) {
      for (const side of ["over", "under"]) {
        const stat = rateStats(sample, side === "over" ? (r) => Number(r.total_goals) > line : (r) => Number(r.total_goals) < line);
        if (stat.rate < threshold) continue;
        candidates.push(splitCard({
          game,
          category: "h2h_market",
          type: `h2h_game_total_${side}_${lineKey(line)}_w${window}`,
          score: h2hScore(stat, window) + utilityBonus("game_total", line),
          eyebrow: `ЛИЧНЫЕ ВСТРЕЧИ · ${window}`,
          value: `${stat.hits}/${window}`,
          title: `${game.away_tri} — ${game.home_tri}: ${side === "over" ? "ТБ" : "ТМ"} ${line} прошёл ${stat.hits} из последних ${window}`,
          explanation: `Оценивается точная рыночная линия только по предыдущим очным матчам этих команд. H2H получает меньший базовый вес, чем общекомандные rolling-тренды.`,
          evidence: { window, split: "h2h", ...evidenceStats(stat, sample) },
          market: { type: "game_total", subject: null, side, line, label: `${side === "over" ? "ТБ" : "ТМ"} ${line}` },
        }));
      }
    }

    for (const [team, gfKey] of [[game.away_tri, "final_goals_for"], [game.home_tri, "final_goals_against"]]) {
      for (const line of TEAM_TOTAL_LINES) {
        for (const side of ["over", "under"]) {
          const stat = rateStats(sample, side === "over" ? (r) => Number(r[gfKey]) > line : (r) => Number(r[gfKey]) < line);
          if (stat.rate < threshold) continue;
          candidates.push(splitCard({
            game,
            category: "h2h_market",
            type: `h2h_team_total_${team}_${side}_${lineKey(line)}_w${window}`,
            score: h2hScore(stat, window) + utilityBonus("team_total", line),
            eyebrow: `H2H · ${team} · ИТ ${line}`,
            value: `${stat.hits}/${window}`,
            title: `${team}: ${side === "over" ? "ИТБ" : "ИТМ"} ${line} в ${stat.hits} из последних ${window} очных матчей`,
            explanation: `Точная линия командного тотала в очных встречах ${game.away_tri} и ${game.home_tri}.`,
            evidence: { window, split: "h2h", team, ...evidenceStats(stat, sample) },
            market: { type: "team_total", subject: team, side, line, label: `${team} ${side === "over" ? "ИТБ" : "ИТМ"} ${line}` },
          }));
        }
      }
    }

    for (const [team, diffFn] of [
      [game.away_tri, (r) => Number(r.final_goal_diff)],
      [game.home_tri, (r) => -Number(r.final_goal_diff)],
    ]) {
      for (const line of HANDICAP_LINES) {
        const stat = rateStats(sample, (r) => diffFn(r) + line > 0);
        if (stat.rate < threshold) continue;
        candidates.push(splitCard({
          game,
          category: "h2h_market",
          type: `h2h_handicap_${team}_${handicapKey(line)}_w${window}`,
          score: h2hScore(stat, window) + utilityBonus("handicap", line),
          eyebrow: `H2H · ${team} · ФОРА`,
          value: `${stat.hits}/${window}`,
          title: `${team} закрыл фору ${signedLine(line)} в ${stat.hits} из последних ${window} очных матчей`,
          explanation: `Фора рассчитана по фактической финальной разнице шайб в очных матчах.`,
          evidence: { window, split: "h2h", team, ...evidenceStats(stat, sample) },
          market: { type: "handicap", subject: team, side: team, line, label: `${team} ${signedLine(line)}` },
        }));
      }
    }

    for (const [team, pred] of [
      [game.away_tri, (r) => Number(r.final_win) === 1],
      [game.home_tri, (r) => Number(r.final_win) === 0],
    ]) {
      const stat = rateStats(sample, pred);
      if (stat.rate < threshold) continue;
      candidates.push(splitCard({
        game,
        category: "h2h_market",
        type: `h2h_moneyline_${team}_w${window}`,
        score: h2hScore(stat, window),
        eyebrow: `H2H · ПОБЕДЫ`,
        value: `${stat.hits}/${window}`,
        title: `${team} выиграл ${stat.hits} из последних ${window} очных матчей`,
        explanation: `Очные встречи используются как дополнительный контекст, а не как самостоятельный прогноз.`,
        evidence: { window, split: "h2h", team, ...evidenceStats(stat, sample) },
        market: { type: "moneyline", subject: team, side: team, line: null, label: `Победа ${team}` },
      }));
    }
  }

  return selectSplitPortfolio(candidates, 5);
}

function venueTeamCandidates(game, team, sample, window, threshold, roleLabel) {
  const out = [];
  for (const line of TEAM_TOTAL_LINES) {
    for (const side of ["over", "under"]) {
      const stat = rateStats(sample, side === "over" ? (r) => Number(r.final_goals_for) > line : (r) => Number(r.final_goals_for) < line);
      if (stat.rate < threshold) continue;
      out.push(splitCard({
        game,
        category: "venue_split",
        type: `venue_team_total_${team}_${side}_${lineKey(line)}_w${window}`,
        score: venueSingleScore(stat, window) + utilityBonus("team_total", line),
        eyebrow: `${team} · ${roleLabel.toUpperCase()}`,
        value: `${stat.hits}/${window}`,
        title: `${team} ${roleLabel}: ${side === "over" ? "ИТБ" : "ИТМ"} ${line} — ${stat.hits}/${window}`,
        explanation: `Используются только последние ${window} матчей ${team} в текущей роли площадки.`,
        evidence: { window, split: "current_venue", role: roleLabel, team, ...evidenceStats(stat, sample) },
        market: { type: "team_total", subject: team, side, line, label: `${team} ${side === "over" ? "ИТБ" : "ИТМ"} ${line}` },
      }));
    }
  }

  for (const line of HANDICAP_LINES) {
    const stat = rateStats(sample, (r) => Number(r.final_goal_diff) + line > 0);
    if (stat.rate < threshold) continue;
    out.push(splitCard({
      game,
      category: "venue_split",
      type: `venue_handicap_${team}_${handicapKey(line)}_w${window}`,
      score: venueSingleScore(stat, window) + utilityBonus("handicap", line),
      eyebrow: `${team} · ${roleLabel.toUpperCase()} · ФОРА`,
      value: `${stat.hits}/${window}`,
      title: `${team} ${roleLabel} закрыл фору ${signedLine(line)} в ${stat.hits}/${window}`,
      explanation: `Фора рассчитана только на матчах ${team} в текущей роли площадки.`,
      evidence: { window, split: "current_venue", role: roleLabel, team, ...evidenceStats(stat, sample) },
      market: { type: "handicap", subject: team, side: team, line, label: `${team} ${signedLine(line)}` },
    }));
  }

  const win = rateStats(sample, (r) => Number(r.final_win) === 1);
  if (win.rate >= threshold) {
    out.push(splitCard({
      game,
      category: "venue_split",
      type: `venue_moneyline_${team}_w${window}`,
      score: venueSingleScore(win, window),
      eyebrow: `${team} · ${roleLabel.toUpperCase()} · ПОБЕДЫ`,
      value: `${win.hits}/${window}`,
      title: `${team} выиграл ${win.hits} из последних ${window} матчей ${roleLabel}`,
      explanation: `Победный сплит только по текущей роли площадки.`,
      evidence: { window, split: "current_venue", role: roleLabel, team, ...evidenceStats(win, sample) },
      market: { type: "moneyline", subject: team, side: team, line: null, label: `Победа ${team}` },
    }));
  }

  return out;
}

function selectSplitPortfolio(cards, limit) {
  const bestExact = new Map();
  for (const card of cards) {
    const key = `${card.market.type}:${card.market.subject || "all"}:${card.market.side || "none"}:${normalizeLine(card.market.line)}`;
    const current = bestExact.get(key);
    if (!current || compare(card, current) < 0) bestExact.set(key, card);
  }

  const sorted = [...bestExact.values()].sort(compare);
  const selected = [];
  const families = new Map();
  for (const card of sorted) {
    const bucket = familyBucket(card.market);
    const used = families.get(bucket) || 0;
    const max = card.market.type === "moneyline" ? 2 : 1;
    if (used >= max) continue;
    selected.push(card);
    families.set(bucket, used + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function splitCard({ game, category, type, score, eyebrow, value, title, explanation, evidence, market }) {
  const id = `${game.game_pk}:${category}:${type}`;
  const pricedMarket = withDemoOdds(market, id);
  return {
    id,
    insight_type: type,
    category,
    kind: "history",
    timing: "pregame",
    score: Math.round(Math.max(0, Math.min(96, score))),
    eyebrow,
    value,
    title,
    explanation,
    evidence: { ...evidence, feature_layer: "team_game_features_v2_market_splits" },
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    market: pricedMarket,
  };
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

function venueSingleScore(stat, window) {
  const bonus = window === 20 ? 7 : window === 10 ? 4 : 1;
  return 52 + stat.rate * 18 + stat.wilson90 * 10 + bonus;
}

function venueConfluenceScore(a, b, window) {
  const bonus = window === 20 ? 7 : window === 10 ? 4 : 1;
  return 53 + ((a.rate + b.rate) / 2) * 18 + ((a.wilson90 + b.wilson90) / 2) * 10 + bonus;
}

function h2hScore(stat, window) {
  const bonus = window === 10 ? 5 : window === 6 ? 3 : 1;
  return 48 + stat.rate * 18 + stat.wilson90 * 10 + bonus;
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

function utilityBonus(type, line) {
  if (type === "game_total" && (line === 5.5 || line === 6.5)) return 3;
  if (type === "team_total" && (line === 2.5 || line === 3.5)) return 3;
  if (type === "handicap" && Math.abs(line) === 1.5) return 3;
  return 0;
}

function familyBucket(market) {
  if (market.type === "game_total") return "game_total";
  if (market.type === "team_total") return `team_total:${market.subject}`;
  if (market.type === "handicap") return `handicap:${market.subject}`;
  if (market.type === "moneyline") return "moneyline";
  return `${market.type}:${market.subject || "all"}`;
}

function compare(a, b) {
  const score = Number(b.score || 0) - Number(a.score || 0);
  if (score) return score;
  return Number(b.evidence?.window || 0) - Number(a.evidence?.window || 0);
}

function normalizeLine(line) {
  if (line === null || line === undefined || line === "") return "none";
  const n = Number(line);
  return Number.isFinite(n) ? n.toFixed(1) : String(line);
}

function lineKey(line) { return String(line).replace(".", "_"); }
function handicapKey(line) { return `${line < 0 ? "m" : "p"}${lineKey(Math.abs(line))}`; }
function signedLine(line) { return `${line > 0 ? "+" : ""}${Number(line).toFixed(1)}`; }
