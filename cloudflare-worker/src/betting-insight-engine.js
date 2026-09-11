import { withDemoOdds } from "./demo-winline-odds.js";
import { buildFeatureMarketInsights } from "./feature-market-insights.js";
import { buildUniversalMarketInsights } from "./universal-market-evaluator.js";
import { buildRollingLeagueRankInsights } from "./rolling-league-ranks.js";
import { buildAdvancedMarketContextInsights } from "./advanced-market-context.js";
import { selectInsightPortfolio } from "./insight-portfolio.js";
import { buildMarketSplitInsights } from "./market-split-insights.js";

const EAST = new Set([
  "BOS","BUF","CAR","CBJ","DET","FLA","MTL","NJD","NYI","NYR","OTT","PHI","PIT","TBL","TOR","WSH",
]);

export async function buildBettingInsights(db, game) {
  if (!db || !game?.game_pk) return [];

  const away = game.away_tri;
  const home = game.home_tri;
  const before = game.scheduled_start_utc;
  const season = String(game.season_id || "");

  const [momentumR, awayFormR, homeFormR, periodR, h2hR, conferenceR] = await db.batch([
    db.prepare(`
      SELECT team_tri,event_type,sort_order,period_number,time_in_period
      FROM game_events
      WHERE game_pk=?
        AND team_tri IS NOT NULL
        AND event_type IN ('shot-on-goal','goal')
      ORDER BY sort_order DESC
      LIMIT 20;
    `).bind(game.game_pk),
    recentGamesStatement(db, away, before),
    recentGamesStatement(db, home, before),
    db.prepare(`
      WITH team_period AS (
        SELECT g.game_pk,g.home_tri AS team_tri,ps.home_goals AS gf,ps.away_goals AS ga
        FROM games g JOIN period_scores ps ON ps.game_pk=g.game_pk
        WHERE g.season_id=? AND g.game_type IN (2,3) AND g.scheduled_start_utc<? AND ps.period_number=2
        UNION ALL
        SELECT g.game_pk,g.away_tri AS team_tri,ps.away_goals AS gf,ps.home_goals AS ga
        FROM games g JOIN period_scores ps ON ps.game_pk=g.game_pk
        WHERE g.season_id=? AND g.game_type IN (2,3) AND g.scheduled_start_utc<? AND ps.period_number=2
      )
      SELECT team_tri,COUNT(*) AS games,SUM(gf) AS gf,SUM(ga) AS ga,
             1.0*(SUM(gf)-SUM(ga))/COUNT(*) AS diff_pg,
             1.0*SUM(gf)/COUNT(*) AS gf_pg
      FROM team_period
      GROUP BY team_tri
      ORDER BY diff_pg DESC,gf_pg DESC;
    `).bind(season,before,season,before),
    db.prepare(`
      SELECT game_pk,scheduled_start_utc,home_tri,away_tri,home_score,away_score
      FROM games
      WHERE game_type IN (2,3)
        AND scheduled_start_utc<?
        AND ((home_tri=? AND away_tri=?) OR (home_tri=? AND away_tri=?))
      ORDER BY scheduled_start_utc DESC
      LIMIT 10;
    `).bind(before,home,away,away,home),
    db.prepare(conferenceSql()).bind(season,before),
  ]);

  const featureInsights = await safeInsightBuild("feature_market", () => buildFeatureMarketInsights(db, game));
  const universalMarketInsights = await safeInsightBuild("universal_market", () => buildUniversalMarketInsights(db, game));
  const rollingRankInsights = await safeInsightBuild("rolling_rank", () => buildRollingLeagueRankInsights(db, game));
  const advancedContextInsights = await safeInsightBuild("advanced_context", () => buildAdvancedMarketContextInsights(db, game));
  const marketSplitInsights = await safeInsightBuild("market_splits", () => buildMarketSplitInsights(db, game));

  const insights = [];
  insights.push(...momentumInsights(momentumR.results || [], game));
  insights.push(...formInsights(awayFormR.results || [], away, home));
  insights.push(...formInsights(homeFormR.results || [], home, away));
  insights.push(...periodInsights(periodR.results || [], game));
  insights.push(...h2hInsights(h2hR.results || [], game));
  insights.push(...conferenceInsights(conferenceR.results?.[0] || null, game));
  insights.push(...universalMarketInsights);
  insights.push(...rollingRankInsights);
  insights.push(...advancedContextInsights);
  insights.push(...marketSplitInsights);
  insights.push(...featureInsights);

  return selectInsightPortfolio(dedupe(insights), 12);
}

async function safeInsightBuild(label, factory) {
  try {
    const value = await factory();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.error(`betting insight module failed: ${label}`, error);
    return [];
  }
}

function recentGamesStatement(db, team, before) {
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,home_tri,away_tri,home_score,away_score,
           CASE WHEN home_tri=? THEN home_score ELSE away_score END AS gf,
           CASE WHEN home_tri=? THEN away_score ELSE home_score END AS ga,
           CASE
             WHEN home_tri=? AND home_score>away_score THEN 1
             WHEN away_tri=? AND away_score>home_score THEN 1
             ELSE 0
           END AS win
    FROM games
    WHERE game_type IN (2,3)
      AND scheduled_start_utc<?
      AND (home_tri=? OR away_tri=?)
    ORDER BY scheduled_start_utc DESC
    LIMIT 10;
  `).bind(team,team,team,team,before,team,team);
}

function momentumInsights(rows, game) {
  if (rows.length < 12) return [];
  const counts = countBy(rows, r => r.team_tri);
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return [];
  const [leader, count] = entries[0];
  const share = count / rows.length;
  if (share < 0.65 || count - (rows.length-count) < 4) return [];
  return [card({
    game,
    type:"shot_momentum",
    category:"live",
    timing:"live",
    score:Math.min(99,78 + (share-.65)*80),
    eyebrow:"ДАВЛЕНИЕ ПРЯМО СЕЙЧАС",
    value:`${count} из ${rows.length}`,
    title:`${leader} нанёс ${count} из последних ${rows.length} бросков в створ`,
    explanation:"Сигнал на территориальное давление. Сам по себе не прогнозирует гол, но хорошо стыкуется с live-рынком следующего гола.",
    sample:rows.length,
    evidence:{shots_by_team:counts,last_event_sort_order:rows[0]?.sort_order||null},
    market:{type:"next_goal_team",subject:leader,side:leader,label:`Следующий гол — ${leader}`},
  })];
}

function formInsights(rows, team, opponent) {
  const n = rows.length;
  if (n < 5) return [];
  const wins = rows.reduce((s,r)=>s+Number(r.win||0),0);
  const winPct = wins/n;
  const gf = rows.reduce((s,r)=>s+Number(r.gf||0),0);
  const ga = rows.reduce((s,r)=>s+Number(r.ga||0),0);
  const avgTotal = (gf+ga)/n;
  const out=[];

  if (winPct >= .70) {
    out.push(card({
      type:"recent_form",category:"history",timing:"pregame",score:78+(winPct-.70)*35,
      eyebrow:"ФОРМА · ПОСЛЕДНИЕ МАТЧИ",value:`${wins}/${n}`,
      title:`${team} выиграл ${wins} из последних ${n} матчей`,
      explanation:`Голы на этом отрезке: ${gf}:${ga}. Это контекст к исходу матча, а не отдельная модель вероятности.`,
      sample:n,evidence:{wins,gf,ga,game_pks:rows.map(r=>r.game_pk)},
      market:{type:"moneyline",subject:team,side:team,label:`Победа ${team}`},
    }));
  } else if (winPct <= .30) {
    out.push(card({
      type:"recent_form_bad",category:"history",timing:"pregame",score:75+(.30-winPct)*35,
      eyebrow:"НЕГАТИВНАЯ ФОРМА",value:`${wins}/${n}`,
      title:`${team} выиграл только ${wins} из последних ${n} матчей`,
      explanation:`Голы на этом отрезке: ${gf}:${ga}. Логичный рынок для проверки — соперник или двойной шанс/фора, когда появится линия Winline.`,
      sample:n,evidence:{wins,gf,ga,game_pks:rows.map(r=>r.game_pk)},
      market:{type:"moneyline",subject:opponent,side:opponent,label:`Победа ${opponent}`},
    }));
  }

  if (avgTotal >= 6.8 || avgTotal <= 5.2) {
    const over = avgTotal >= 6.8;
    out.push(card({
      type:over?"recent_total_over":"recent_total_under",category:"history",timing:"pregame",
      score:72+Math.min(16,Math.abs(avgTotal-6)*8),
      eyebrow:"ТОТАЛ · ПОСЛЕДНИЕ МАТЧИ",value:avgTotal.toFixed(1),
      title:`В последних ${n} матчах ${team} команды забивали в среднем ${avgTotal.toFixed(1)} гола суммарно`,
      explanation:"Сравниваем с фактической линией тотала Winline перед эфиром; без линии это только статистический контекст.",
      sample:n,evidence:{goals_for:gf,goals_against:ga,avg_total:avgTotal,game_pks:rows.map(r=>r.game_pk)},
      market:{type:"game_total",subject:null,side:over?"over":"under",label:over?"Тотал больше":"Тотал меньше"},
    }));
  }
  return out;
}

function periodInsights(rows, game) {
  if (!rows.length) return [];
  const eligible = rows.filter(r=>Number(r.games)>=8);
  if (eligible.length < 8) return [];
  const sorted=[...eligible].sort((a,b)=>Number(b.diff_pg)-Number(a.diff_pg));
  const out=[];
  for (const team of [game.away_tri,game.home_tri]) {
    const idx=sorted.findIndex(r=>r.team_tri===team);
    if (idx<0) continue;
    const r=sorted[idx],rank=idx+1,n=Number(r.games),diff=Number(r.diff_pg);
    if (rank<=3) {
      out.push(card({
        type:"period2_rank_best",category:"period",timing:"pregame",score:88-rank*2,
        eyebrow:"ВТОРОЙ ПЕРИОД",value:`#${rank} в НХЛ`,
        title:`${team} — ${rank}-я команда лиги по разнице шайб во вторых периодах`,
        explanation:`Разница во вторых периодах: ${Number(r.gf)}:${Number(r.ga)} за ${n} матчей (${signed(diff)} за игру).`,
        sample:n,evidence:{rank,gf:Number(r.gf),ga:Number(r.ga),diff_per_game:diff},
        market:{type:"period_2_result",subject:team,side:team,label:`2-й период — ${team}`},
      }));
    } else if (rank>=Math.max(eligible.length-2,1)) {
      out.push(card({
        type:"period2_rank_worst",category:"period",timing:"pregame",score:82,
        eyebrow:"СЛАБЫЙ ВТОРОЙ ПЕРИОД",value:`#${rank} из ${eligible.length}`,
        title:`${team} — внизу лиги по разнице шайб во вторых периодах`,
        explanation:`Разница во вторых периодах: ${Number(r.gf)}:${Number(r.ga)} за ${n} матчей (${signed(diff)} за игру).`,
        sample:n,evidence:{rank,gf:Number(r.gf),ga:Number(r.ga),diff_per_game:diff},
        market:{type:"period_2_opponent",subject:team,side:"against",label:`Соперник ${team} во 2-м периоде`},
      }));
    }
  }
  return out;
}

function h2hInsights(rows, game) {
  if (rows.length < 3) return [];
  const wins={[game.away_tri]:0,[game.home_tri]:0};
  let totalGoals=0;
  for (const r of rows) {
    totalGoals += Number(r.home_score||0)+Number(r.away_score||0);
    const winner=Number(r.home_score)>Number(r.away_score)?r.home_tri:r.away_tri;
    if (winner in wins) wins[winner]++;
  }
  const n=rows.length;
  const [leader,count]=Object.entries(wins).sort((a,b)=>b[1]-a[1])[0];
  const out=[];
  if (count/n >= .67) {
    out.push(card({
      type:"head_to_head",category:"matchup",timing:"pregame",score:76+(count/n-.67)*30,
      eyebrow:"ЛИЧНЫЕ ВСТРЕЧИ",value:`${count}/${n}`,
      title:`${leader} выиграл ${count} из последних ${n} очных матчей`,
      explanation:"Очные встречи — отдельный контекст, который не заменяет текущую форму и составы.",
      sample:n,evidence:{wins,game_pks:rows.map(r=>r.game_pk)},
      market:{type:"moneyline",subject:leader,side:leader,label:`Победа ${leader}`},
    }));
  }
  const avg=totalGoals/n;
  if (avg>=6.8 || avg<=5.2) {
    out.push(card({
      type:"h2h_total",category:"matchup",timing:"pregame",score:70,
      eyebrow:"ТОТАЛ В ОЧНЫХ МАТЧАХ",value:avg.toFixed(1),
      title:`В последних ${n} очных матчах было в среднем ${avg.toFixed(1)} гола`,
      explanation:"Использовать только вместе с актуальной линией тотала Winline.",
      sample:n,evidence:{avg_total:avg,game_pks:rows.map(r=>r.game_pk)},
      market:{type:"game_total",subject:null,side:avg>=6.8?"over":"under",label:avg>=6.8?"Тотал больше":"Тотал меньше"},
    }));
  }
  return out;
}

function conferenceInsights(row, game) {
  const homeEast=EAST.has(game.home_tri),awayEast=EAST.has(game.away_tri);
  if (homeEast===awayEast || !row) return [];
  const n=Number(row.games||0),eastWins=Number(row.east_wins||0);
  if (n<30) return [];
  const pct=eastWins/n;
  if (pct>.42 && pct<.58) return [];
  const eastTeam=homeEast?game.home_tri:game.away_tri;
  const westTeam=homeEast?game.away_tri:game.home_tri;
  const eastFav=pct>=.58;
  const subject=eastFav?eastTeam:westTeam;
  return [card({
    type:"interconference",category:"league",timing:"pregame",score:68+Math.abs(pct-.5)*60,
    eyebrow:"ВОСТОК × ЗАПАД",value:`${Math.round((eastFav?pct:1-pct)*100)}%`,
    title:`${eastFav?"Восток":"Запад"} выиграл ${eastFav?eastWins:n-eastWins} из ${n} межконференционных матчей сезона`,
    explanation:"Лиговый тренд. Слабее командных и live-сигналов, поэтому получает меньший приоритет.",
    sample:n,evidence:{games:n,east_wins:eastWins,west_wins:n-eastWins},
    market:{type:"moneyline",subject,side:subject,label:`Победа ${subject}`},
  })];
}

function conferenceSql() {
  const east=[...EAST].map(x=>`'${x}'`).join(',');
  return `
    SELECT COUNT(*) AS games,
      SUM(CASE
        WHEN home_tri IN (${east}) AND home_score>away_score THEN 1
        WHEN away_tri IN (${east}) AND away_score>home_score THEN 1
        ELSE 0 END) AS east_wins
    FROM games
    WHERE season_id=? AND game_type=2 AND scheduled_start_utc<?
      AND ((home_tri IN (${east}) AND away_tri NOT IN (${east}))
        OR (away_tri IN (${east}) AND home_tri NOT IN (${east})));
  `;
}

function card({game=null,type,category,timing,score,eyebrow,value,title,explanation,sample,evidence,market}) {
  const idParts=[game?.game_pk||"context",type,market?.subject||"all",String(sample||0)];
  const id=idParts.join(":");
  const pricedMarket=withDemoOdds(market,id);
  return {
    id,
    insight_type:type,
    category,
    timing,
    score:Math.round(Math.max(0,Math.min(100,score))),
    eyebrow,
    value,
    title,
    explanation,
    evidence:{sample_size:sample,...evidence},
    note:`${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    kind:category==="live"?"live":"history",
    market:pricedMarket,
  };
}

function countBy(rows,keyFn){const out={};for(const r of rows){const k=keyFn(r);if(k)out[k]=(out[k]||0)+1}return out}
function signed(v){const n=Number(v||0);return `${n>0?"+":""}${n.toFixed(2)}`}
function dedupe(items){const seen=new Set();return items.filter(x=>{const key=`${x.insight_type}:${x.market?.subject||""}:${x.market?.side||""}`;if(seen.has(key))return false;seen.add(key);return true})}
