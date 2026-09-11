import { withDemoOdds } from "./demo-winline-odds.js";
import { buildFeatureMarketInsights } from "./feature-market-insights.js";
import { buildUniversalMarketInsights } from "./universal-market-evaluator.js";
import { buildRollingLeagueRankInsights } from "./rolling-league-ranks.js";
import { buildAdvancedMarketContextInsights } from "./advanced-market-context.js";
import { selectInsightPortfolio } from "./insight-portfolio.js";
import { buildMarketSplitInsights } from "./market-split-insights.js";
import { buildRegulationMarketInsights } from "./regulation-market-evaluator.js";
import { applyWinlineMarkets } from "./winline-market-adapter.js";
import { buildSnapshotMarketContextInsights } from "./snapshot-market-context.js";
import { buildPlayerMarketInsights } from "./player-market-insights.js";

const EAST = new Set([
  "BOS","BUF","CAR","CBJ","DET","FLA","MTL","NJD","NYI","NYR","OTT","PHI","PIT","TBL","TOR","WSH",
]);

export async function buildBettingInsights(db, game, options = {}) {
  if (!db || !game?.game_pk) return [];

  // Production defaults to a low-read profile suitable for D1 Free.
  // Heavy league-wide context stays opt-in until it is served from
  // precomputed snapshot tables rather than full historical scans.
  const heavyContext = options.enable_heavy_context === true;

  const universalMarketInsights = await safeInsightBuild("universal_market", () => buildUniversalMarketInsights(db, game));
  const regulationMarketInsights = await safeInsightBuild("regulation_market", () => buildRegulationMarketInsights(db, game));
  const marketSplitInsights = await safeInsightBuild("market_splits", () => buildMarketSplitInsights(db, game));
  const snapshotContextInsights = await safeInsightBuild("snapshot_context", () => buildSnapshotMarketContextInsights(db, game));
  const playerMarketInsights = await safeInsightBuild("player_markets", () => buildPlayerMarketInsights(db, game));

  let featureInsights = [];
  let rollingRankInsights = [];
  let advancedContextInsights = [];
  if (heavyContext) {
    featureInsights = await safeInsightBuild("feature_market", () => buildFeatureMarketInsights(db, game));
    rollingRankInsights = await safeInsightBuild("rolling_rank", () => buildRollingLeagueRankInsights(db, game));
    advancedContextInsights = await safeInsightBuild("advanced_context", () => buildAdvancedMarketContextInsights(db, game));
  }

  const rawPortfolio = dedupe([
    ...universalMarketInsights,
    ...regulationMarketInsights,
    ...marketSplitInsights,
    ...snapshotContextInsights,
    ...playerMarketInsights,
    ...featureInsights,
    ...rollingRankInsights,
    ...advancedContextInsights,
  ]);

  let portfolio;
  try {
    portfolio = selectInsightPortfolio(rawPortfolio, 12);
  } catch (error) {
    console.error("betting insight portfolio failed", error);
    portfolio = [...rawPortfolio]
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
      .slice(0, 12);
  }

  try {
    return applyWinlineMarkets(portfolio, options.provider_markets, {
      now: options.now,
      max_age_ms: options.market_max_age_ms,
    });
  } catch (error) {
    console.error("winline market adapter failed", error);
    return portfolio;
  }
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
  if (rows.length < 8) return [];
  const sample=rows.slice(0,10);
  const wins=sample.filter(r=>Number(r.win)===1).length;
  const gf=sample.reduce((s,r)=>s+Number(r.gf||0),0);
  const ga=sample.reduce((s,r)=>s+Number(r.ga||0),0);
  const out=[];
  if (wins>=7) out.push(card({
    type:"recent_form", category:"history", timing:"pregame", score:82+(wins-7)*4,
    eyebrow:"ФОРМА · ПОСЛЕДНИЕ 10",value:`${wins}–${sample.length-wins}`,
    title:`${team} выиграл ${wins} из последних ${sample.length}`,
    explanation:`Разница шайб на этом отрезке: ${gf-ga>=0?"+":""}${gf-ga}.`,
    evidence:{team,opponent,wins,games:sample.length,gf,ga},
    market:{type:"moneyline",subject:team,side:team,label:`Победа ${team}`},
  }));
  const total=(gf+ga)/sample.length;
  if(total>=6.5) out.push(card({
    type:"recent_total_environment",category:"history",timing:"pregame",score:76+Math.min(12,(total-6.5)*7),
    eyebrow:"ГОЛЕВАЯ СРЕДА",value:`${total.toFixed(1)} гола`,
    title:`В последних матчах ${team} в среднем забивают ${total.toFixed(1)} гола обе команды`,
    explanation:"Это исторический контекст по общему тоталу; линия и коэффициент должны приходить из Winline.",
    evidence:{team,games:sample.length,total_goals:gf+ga,average_total:total},
    market:{type:"game_total",subject:null,side:"over",line:5.5,label:"ТБ 5.5"},
  }));
  return out;
}

function periodInsights(rows, game) {
  if (!rows.length) return [];
  const ranked=rows.map((r,i)=>({...r,rank:i+1,total:rows.length}));
  const result=[];
  for(const team of [game.away_tri,game.home_tri]){
    const r=ranked.find(x=>x.team_tri===team);
    if(!r || Number(r.games)<8) continue;
    const rank=Number(r.rank);
    if(rank<=3){
      result.push(card({
        game,type:"second_period_rank",category:"period",timing:"pregame",score:84+(4-rank)*3,
        eyebrow:"2-Й ПЕРИОД · РЕЙТИНГ НХЛ",value:`№${rank}`,
        title:`${team} — №${rank} в НХЛ по разнице шайб во втором периоде`,
        explanation:`${Number(r.diff_pg).toFixed(2)} шайбы разницы за второй период в среднем на матч.`,
        evidence:{team,rank,total:Number(r.total),games:Number(r.games),diff_pg:Number(r.diff_pg),gf_pg:Number(r.gf_pg)},
        market:{type:"period_2_result",subject:team,side:team,label:`2-й период — ${team}`},
      }));
    }
  }
  return result;
}

function h2hInsights(rows, game) {
  if(rows.length<4) return [];
  const wins={[game.home_tri]:0,[game.away_tri]:0};
  let total=0;
  for(const r of rows){
    const hs=Number(r.home_score), as=Number(r.away_score);
    if(hs>as) wins[r.home_tri]=(wins[r.home_tri]||0)+1;
    else if(as>hs) wins[r.away_tri]=(wins[r.away_tri]||0)+1;
    total+=hs+as;
  }
  const [leader,count]=Object.entries(wins).sort((a,b)=>b[1]-a[1])[0];
  const out=[];
  if(count/rows.length>=0.7) out.push(card({
    game,type:"h2h_dominance",category:"matchup",timing:"pregame",score:80+(count/rows.length-.7)*30,
    eyebrow:"ЛИЧНЫЕ ВСТРЕЧИ",value:`${count}/${rows.length}`,
    title:`${leader} выиграл ${count} из последних ${rows.length} очных матчей`,
    explanation:"H2H — контекст, а не самостоятельный прогноз; используем только при выраженном перевесе.",
    evidence:{wins,sample:rows.length,game_pks:rows.map(r=>r.game_pk)},
    market:{type:"moneyline",subject:leader,side:leader,label:`Победа ${leader}`},
  }));
  const avg=total/rows.length;
  if(avg>=6.5) out.push(card({
    game,type:"h2h_total",category:"matchup",timing:"pregame",score:76+Math.min(12,(avg-6.5)*7),
    eyebrow:"H2H · ТОТАЛ",value:`${avg.toFixed(1)}`,
    title:`В последних ${rows.length} очных матчах — ${avg.toFixed(1)} гола в среднем`,
    explanation:"Высокий исторический тотал личных встреч.",
    evidence:{average_total:avg,sample:rows.length},
    market:{type:"game_total",subject:null,side:"over",line:5.5,label:"ТБ 5.5"},
  }));
  return out;
}

function conferenceInsights(row, game) {
  if(!row) return [];
  const east=Number(row.east_wins||0), west=Number(row.west_wins||0), games=east+west;
  if(games<20) return [];
  const diff=Math.abs(east-west)/games;
  if(diff<0.12) return [];
  const favored=east>west?"EAST":"WEST";
  const favoredTeam=[game.away_tri,game.home_tri].find(t=>(EAST.has(t)?"EAST":"WEST")===favored);
  if(!favoredTeam) return [];
  return [card({
    game,type:"conference_edge",category:"history",timing:"pregame",score:70+diff*40,
    eyebrow:"ВОСТОК × ЗАПАД",value:`${favored} ${Math.max(east,west)}–${Math.min(east,west)}`,
    title:`В этом сезоне ${favored==="EAST"?"Восток":"Запад"} имеет перевес в межконференционных матчах`,
    explanation:"Лиговый контекст с более низким весом, чем форма команд и H2H.",
    evidence:{season_id:game.season_id,games,east_wins:east,west_wins:west},
    market:{type:"moneyline",subject:favoredTeam,side:favoredTeam,label:`Победа ${favoredTeam}`},
  })];
}

function card({game=null,type,category,timing,score,eyebrow,value,title,explanation,sample=null,evidence,market}) {
  const id=`${game?.game_pk||"league"}:${type}:${market?.subject||market?.side||"all"}`;
  const pricedMarket=withDemoOdds(market,id);
  return {
    id,insight_type:type,category,kind:timing==="live"?"live":"history",timing,
    score:Math.round(Math.max(0,Math.min(100,score))),eyebrow,value,title,explanation,sample,evidence,
    note:`${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    market:pricedMarket,
  };
}

function countBy(rows,keyFn){
  const out={}; for(const r of rows){const k=keyFn(r); if(k) out[k]=(out[k]||0)+1;} return out;
}

function dedupe(cards){
  const m=new Map();
  for(const c of cards){const key=`${c.insight_type}:${c.market?.subject||c.market?.side||"all"}`; if(!m.has(key)||m.get(key).score<c.score)m.set(key,c);}
  return [...m.values()];
}

function conferenceSql(){
  return `
    WITH tagged AS (
      SELECT home_tri,away_tri,home_score,away_score,
             CASE WHEN home_tri IN ('BOS','BUF','CAR','CBJ','DET','FLA','MTL','NJD','NYI','NYR','OTT','PHI','PIT','TBL','TOR','WSH') THEN 'EAST' ELSE 'WEST' END AS home_conf,
             CASE WHEN away_tri IN ('BOS','BUF','CAR','CBJ','DET','FLA','MTL','NJD','NYI','NYR','OTT','PHI','PIT','TBL','TOR','WSH') THEN 'EAST' ELSE 'WEST' END AS away_conf
      FROM games
      WHERE season_id=? AND game_type IN (2,3) AND scheduled_start_utc<?
    )
    SELECT
      SUM(CASE WHEN home_conf<>away_conf AND ((home_score>away_score AND home_conf='EAST') OR (away_score>home_score AND away_conf='EAST')) THEN 1 ELSE 0 END) AS east_wins,
      SUM(CASE WHEN home_conf<>away_conf AND ((home_score>away_score AND home_conf='WEST') OR (away_score>home_score AND away_conf='WEST')) THEN 1 ELSE 0 END) AS west_wins
    FROM tagged;
  `;
}
