import { withDemoOdds } from "./demo-winline-odds.js";

const MIN_CORE_SAMPLE = 8;

export async function buildFeatureMarketInsights(db, game) {
  if (!db || !game?.game_pk) return [];

  const before = game.scheduled_start_utc;
  const teams = [game.away_tri, game.home_tri];
  const [awayRowsR, homeRowsR, currentR, p2LeagueR] = await db.batch([
    recentFeatureStatement(db, game.away_tri, before),
    recentFeatureStatement(db, game.home_tri, before),
    db.prepare(`
      SELECT * FROM team_game_features
      WHERE game_pk=? AND team_tri IN (?,?);
    `).bind(game.game_pk, game.away_tri, game.home_tri),
    db.prepare(`
      SELECT team_tri,COUNT(*) AS games,
             SUM(p2_goals_for) AS gf,SUM(p2_goals_against) AS ga,
             1.0*SUM(p2_goals_for-p2_goals_against)/COUNT(*) AS diff_pg,
             1.0*SUM(p2_goals_for)/COUNT(*) AS gf_pg
      FROM team_game_features
      WHERE season_id=? AND scheduled_start_utc<?
      GROUP BY team_tri
      HAVING COUNT(*)>=8
      ORDER BY diff_pg DESC,gf_pg DESC;
    `).bind(String(game.season_id), before),
  ]);

  const rowsByTeam = new Map([
    [game.away_tri, awayRowsR.results || []],
    [game.home_tri, homeRowsR.results || []],
  ]);
  const currentByTeam = new Map((currentR.results || []).map((row) => [row.team_tri, row]));
  const out = [];

  for (const team of teams) {
    const opponent = team === game.home_tri ? game.away_tri : game.home_tri;
    const rows = rowsByTeam.get(team) || [];
    const oppRows = rowsByTeam.get(opponent) || [];
    out.push(...teamTotalInsights(game, team, opponent, rows, oppRows));
    out.push(...gameTotalInsights(game, team, rows));
    out.push(...handicapInsights(game, team, rows));
    out.push(...firstGoalInsights(game, team, rows));
    out.push(...periodResultInsights(game, team, rows));
    out.push(...venueInsights(game, team, rows));
    out.push(...possessionInsights(game, team, rows));
    out.push(...restInsights(game, team, rows, currentByTeam.get(team) || null));
  }

  out.push(...secondPeriodLeagueInsights(game, p2LeagueR.results || []));
  return dedupe(out).sort((a, b) => b.score - a.score).slice(0, 16);
}

function recentFeatureStatement(db, team, before) {
  return db.prepare(`
    SELECT *
    FROM team_game_features
    WHERE team_tri=? AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT 20;
  `).bind(team, before);
}

function teamTotalInsights(game, team, opponent, rows, oppRows) {
  const sample = rows.slice(0, 10);
  if (sample.length < MIN_CORE_SAMPLE) return [];
  const over = hitRate(sample, (r) => Number(r.final_goals_for) >= 3);
  const under = 1 - over;
  const out = [];
  if (over >= 0.70 || under >= 0.70) {
    const isOver = over >= 0.70;
    const hits = Math.round((isOver ? over : under) * sample.length);
    out.push(featureCard({
      game, team, type: isOver ? "team_total_over_2_5" : "team_total_under_2_5",
      score: 78 + Math.abs((isOver ? over : under) - 0.70) * 45,
      eyebrow: "КОМАНДНЫЙ ТОТАЛ · 2.5",
      value: `${hits}/${sample.length}`,
      title: `${team} ${isOver ? "забил 3+" : "не забил больше 2"} в ${hits} из последних ${sample.length} матчей`,
      explanation: "Точный hit-rate под демонстрационную линию командного тотала 2.5.",
      evidence: { hit_rate: isOver ? over : under, game_pks: sample.map((r) => r.game_pk) },
      market: { type: "team_total_2_5", subject: team, side: isOver ? "over" : "under", line: 2.5, label: `${team} ${isOver ? "ТБ" : "ТМ"} 2.5` },
    }));
  }

  const oppSample = oppRows.slice(0, 10);
  if (oppSample.length >= MIN_CORE_SAMPLE) {
    const teamScores3 = hitRate(sample, (r) => Number(r.final_goals_for) >= 3);
    const oppAllows3 = hitRate(oppSample, (r) => Number(r.final_goals_against) >= 3);
    if (teamScores3 >= 0.65 && oppAllows3 >= 0.65) {
      out.push(featureCard({
        game, team, type: "team_total_over_2_5_confluence", score: 90,
        eyebrow: "СОВПАДЕНИЕ ТРЕНДОВ",
        value: `${pct(teamScores3)} + ${pct(oppAllows3)}`,
        title: `${team} регулярно забивает 3+, а ${opponent} регулярно пропускает 3+`,
        explanation: "Совпадают атакующий тренд команды и защитный тренд соперника.",
        evidence: { team_over_rate: teamScores3, opponent_allow_rate: oppAllows3 },
        market: { type: "team_total_2_5", subject: team, side: "over", line: 2.5, label: `${team} ТБ 2.5` },
      }));
    }
  }
  return out;
}

function gameTotalInsights(game, team, rows) {
  const sample = rows.slice(0, 10);
  if (sample.length < MIN_CORE_SAMPLE) return [];
  const over55 = hitRate(sample, (r) => Number(r.total_goals) >= 6);
  const side = over55 >= 0.70 ? "over" : over55 <= 0.30 ? "under" : null;
  if (!side) return [];
  const rate = side === "over" ? over55 : 1 - over55;
  const hits = Math.round(rate * sample.length);
  return [featureCard({
    game, team, type: `game_total_5_5_${side}`,
    score: 75 + (rate - 0.70) * 40,
    eyebrow: "ТОТАЛ МАТЧА · 5.5",
    value: `${hits}/${sample.length}`,
    title: `В ${hits} из последних ${sample.length} матчей ${team} тотал был ${side === "over" ? "6+" : "5 или меньше"}`,
    explanation: "Точный hit-rate для линии тотала 5.5.",
    evidence: { hit_rate: rate, average_total: average(sample, "total_goals") },
    market: { type: "game_total_5_5", subject: null, side, line: 5.5, label: `${side === "over" ? "ТБ" : "ТМ"} 5.5` },
  })];
}

function handicapInsights(game, team, rows) {
  const sample = rows.slice(0, 10);
  if (sample.length < MIN_CORE_SAMPLE) return [];
  const covers = hitRate(sample, (r) => Number(r.final_goal_diff) >= 2);
  if (covers < 0.50) return [];
  const hits = Math.round(covers * sample.length);
  return [featureCard({
    game, team, type: "handicap_minus_1_5", score: 72 + (covers - 0.50) * 55,
    eyebrow: "ФОРА · -1.5",
    value: `${hits}/${sample.length}`,
    title: `${team} выиграл в 2+ шайбы в ${hits} из последних ${sample.length} матчей`,
    explanation: "Частота закрытия форы -1.5, без попытки превратить её в вероятность будущего исхода.",
    evidence: { cover_rate: covers, game_pks: sample.map((r) => r.game_pk) },
    market: { type: "handicap", subject: team, side: team, line: -1.5, label: `${team} -1.5` },
  })];
}

function firstGoalInsights(game, team, rows) {
  const sample = rows.filter((r) => r.first_goal_for !== null && r.first_goal_for !== undefined).slice(0, 10);
  if (sample.length < MIN_CORE_SAMPLE) return [];
  const rate = hitRate(sample, (r) => Number(r.first_goal_for) === 1);
  if (rate < 0.70 && rate > 0.30) return [];
  const forTeam = rate >= 0.70;
  const effective = forTeam ? rate : 1 - rate;
  const hits = Math.round(effective * sample.length);
  const subject = forTeam ? team : null;
  return [featureCard({
    game, team, type: forTeam ? "first_goal_for" : "first_goal_against",
    score: 76 + (effective - 0.70) * 45,
    eyebrow: "КТО ЗАБЬЁТ ПЕРВЫМ",
    value: `${hits}/${sample.length}`,
    title: forTeam
      ? `${team} открывал счёт в ${hits} из последних ${sample.length} матчей`
      : `${team} пропускал первым в ${hits} из последних ${sample.length} матчей`,
    explanation: "Историческая частота первого гола.",
    evidence: { rate: effective, game_pks: sample.map((r) => r.game_pk) },
    market: { type: "first_goal_team", subject, side: forTeam ? team : "opponent", label: forTeam ? `Первый гол — ${team}` : `Соперник ${team} забьёт первым` },
  })];
}

function periodResultInsights(game, team, rows) {
  const sample = rows.slice(0, 10);
  if (sample.length < MIN_CORE_SAMPLE) return [];
  const out = [];
  for (const period of [1, 2]) {
    const gfKey = `p${period}_goals_for`;
    const gaKey = `p${period}_goals_against`;
    const wins = hitRate(sample, (r) => Number(r[gfKey]) > Number(r[gaKey]));
    if (wins < 0.60) continue;
    const hits = Math.round(wins * sample.length);
    out.push(featureCard({
      game, team, type: `period_${period}_win_rate`, score: 76 + (wins - 0.60) * 50,
      eyebrow: `${period}-Й ПЕРИОД · ИСХОД`, value: `${hits}/${sample.length}`,
      title: `${team} выиграл ${period}-й период в ${hits} из последних ${sample.length} матчей`,
      explanation: "Период рассматривается как отдельный рынок 1X2.",
      evidence: { win_rate: wins },
      market: { type: `period_${period}_result`, subject: team, side: team, label: `${period}-й период — победа ${team}` },
    }));
  }
  return out;
}

function venueInsights(game, team, rows) {
  const currentIsHome = team === game.home_tri ? 1 : 0;
  const sample = rows.filter((r) => Number(r.is_home) === currentIsHome).slice(0, 10);
  if (sample.length < 5) return [];
  const wins = hitRate(sample, (r) => Number(r.final_win) === 1);
  if (wins < 0.75) return [];
  const hits = Math.round(wins * sample.length);
  return [featureCard({
    game, team, type: currentIsHome ? "home_form" : "away_form",
    score: 80 + (wins - 0.75) * 45,
    eyebrow: currentIsHome ? "ДОМА" : "В ГОСТЯХ", value: `${hits}/${sample.length}`,
    title: `${team} выиграл ${hits} из последних ${sample.length} матчей ${currentIsHome ? "дома" : "в гостях"}`,
    explanation: "Сплит по месту проведения, совпадающий с текущим матчем.",
    evidence: { win_rate: wins },
    market: { type: "moneyline", subject: team, side: team, label: `Победа ${team}` },
  })];
}

function possessionInsights(game, team, rows) {
  const sample = rows.filter((r) => r.corsi_for_pct !== null && r.fenwick_for_pct !== null).slice(0, 10);
  if (sample.length < MIN_CORE_SAMPLE) return [];
  const corsi = average(sample, "corsi_for_pct");
  const fenwick = average(sample, "fenwick_for_pct");
  const shots = average(sample.filter((r) => r.shot_share_pct !== null), "shot_share_pct");
  if (corsi < 54 || fenwick < 53) return [];
  return [featureCard({
    game, team, type: "puck_control", score: 82 + Math.min(14, (corsi - 54) * 2 + (fenwick - 53)),
    eyebrow: "КОНТРОЛЬ АТАКИ", value: `${corsi.toFixed(1)}% CF`,
    title: `${team}: ${corsi.toFixed(1)}% Corsi и ${fenwick.toFixed(1)}% Fenwick за последние ${sample.length} матчей`,
    explanation: "Доля всех и неблокированных бросковых попыток. Обычно не показывается в стандартной ТВ-статистике.",
    evidence: { corsi_for_pct: corsi, fenwick_for_pct: fenwick, shot_share_pct: shots },
    market: { type: "moneyline", subject: team, side: team, label: `Победа ${team}` },
  })];
}

function restInsights(game, team, rows, current) {
  if (!current || Number(current.is_back_to_back) !== 1) return [];
  const sample = rows.filter((r) => Number(r.is_back_to_back) === 1).slice(0, 10);
  if (sample.length < 4) return [];
  const wins = hitRate(sample, (r) => Number(r.final_win) === 1);
  if (wins > 0.40 && wins < 0.65) return [];
  const positive = wins >= 0.65;
  const rate = positive ? wins : 1 - wins;
  const hits = Math.round(rate * sample.length);
  return [featureCard({
    game, team, type: positive ? "b2b_good" : "b2b_bad", score: 70 + Math.min(15, (rate - 0.60) * 40),
    eyebrow: "BACK-TO-BACK", value: `${hits}/${sample.length}`,
    title: positive
      ? `${team} выиграл ${hits} из ${sample.length} последних матчей без дня отдыха`
      : `${team} проиграл ${hits} из ${sample.length} последних матчей без дня отдыха`,
    explanation: "Сплит только по матчам на следующий календарный день.",
    evidence: { sample: sample.length, win_rate: wins },
    market: { type: "moneyline", subject: positive ? team : current.opponent_tri, side: positive ? team : current.opponent_tri, label: positive ? `Победа ${team}` : `Победа ${current.opponent_tri}` },
  })];
}

function secondPeriodLeagueInsights(game, rows) {
  if (rows.length < 20) return [];
  const out = [];
  for (const team of [game.away_tri, game.home_tri]) {
    const index = rows.findIndex((r) => r.team_tri === team);
    if (index < 0) continue;
    const rank = index + 1;
    const r = rows[index];
    if (rank <= 3) {
      out.push(featureCard({
        game, team, type: "p2_league_rank", score: 90 - rank,
        eyebrow: "2-Й ПЕРИОД · ЛИГА", value: `#${rank}`,
        title: `${team} — №${rank} в НХЛ по разнице шайб во вторых периодах`,
        explanation: `За ${Number(r.games)} матчей: ${Number(r.gf)}:${Number(r.ga)}.`,
        evidence: { rank, games: Number(r.games), gf: Number(r.gf), ga: Number(r.ga), diff_pg: Number(r.diff_pg) },
        market: { type: "period_2_result", subject: team, side: team, label: `2-й период — победа ${team}` },
      }));
    }
  }
  return out;
}

function featureCard({ game, team, type, score, eyebrow, value, title, explanation, evidence, market }) {
  const id = `${game.game_pk}:feature:${type}:${team || market?.subject || "all"}`;
  const pricedMarket = withDemoOdds(market, id);
  return {
    id,
    insight_type: type,
    category: "feature",
    kind: "history",
    timing: "pregame",
    score: Math.round(Math.max(0, Math.min(100, score))),
    eyebrow,
    value,
    title,
    explanation,
    evidence: { ...evidence, feature_layer: "team_game_features_v1" },
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    market: pricedMarket,
  };
}

function hitRate(rows, predicate) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + (predicate(row) ? 1 : 0), 0) / rows.length;
}

function average(rows, key) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length;
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function dedupe(cards) {
  const seen = new Set();
  return cards.filter((card) => {
    const key = `${card.insight_type}:${card.market?.type}:${card.market?.subject || "all"}:${card.market?.side || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
