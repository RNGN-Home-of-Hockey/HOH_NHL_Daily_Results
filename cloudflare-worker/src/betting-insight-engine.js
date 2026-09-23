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
import { buildAdvancedTeamSnapshotInsights } from "./advanced-team-snapshot-insights.js";
import { buildAdvancedRollingVenueInsights } from "./advanced-rolling-venue-insights.js";\nimport { buildNarrative } from "./narrative-engine.js";
import { buildMarketCombinationInsights } from "./market-combination-engine.js";

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
  const advancedTeamSnapshotInsights = await safeInsightBuild("advanced_team_snapshot", () => buildAdvancedTeamSnapshotInsights(game));
  const advancedRollingVenueInsights = await safeInsightBuild("advanced_rolling_venue", () => buildAdvancedRollingVenueInsights(db, game));

  // team_game_features is already materialized and compact, so keep it always on:
  // period trends, first goal, rest, possession and exact historical market outcomes
  // should participate in market-first combinations without enabling league-wide scans.
  const featureInsights = await safeInsightBuild("feature_market", () => buildFeatureMarketInsights(db, game));
  let rollingRankInsights = [];
  let advancedContextInsights = [];
  if (heavyContext) {
    rollingRankInsights = await safeInsightBuild("rolling_rank", () => buildRollingLeagueRankInsights(db, game));
    advancedContextInsights = await safeInsightBuild("advanced_context", () => buildAdvancedMarketContextInsights(db, game));
  }

  const basePortfolio = dedupe([
    ...universalMarketInsights,
    ...regulationMarketInsights,
    ...marketSplitInsights,
    ...snapshotContextInsights,
    ...playerMarketInsights,
    ...advancedTeamSnapshotInsights,
    ...advancedRollingVenueInsights,
    ...featureInsights,
    ...rollingRankInsights,
    ...advancedContextInsights,
  ]);

  // Market-first expansion: every real Winline selection can reuse compatible
  // independent Data Core signals. This creates a large candidate pool before
  // exact-price matching and editorial pruning.
  let combinationInsights=[];
  try {
    combinationInsights=buildMarketCombinationInsights(basePortfolio,options.provider_markets,game,{
      now:options.now,
      market_max_age_ms:options.market_max_age_ms,
    });
  } catch (error) {
    console.error("market combination engine failed",error);
  }
  const rawPortfolio=dedupe([...basePortfolio,...combinationInsights]);

  // Match exact Winline selections before portfolio pruning.
  // Otherwise a generic 2.5/1.5 candidate can win a family bucket and remove
  // the actually offered 3.5 line before the adapter ever sees it.
  let marketMatchedCandidates=rawPortfolio;
  try {
    marketMatchedCandidates=applyWinlineMarkets(rawPortfolio, options.provider_markets, {
      now: options.now,
      max_age_ms: options.market_max_age_ms,
    });
  } catch (error) {
    console.error("winline market adapter failed", error);
  }

  let portfolio;
  try {
    const requestedLimit=Number(options.portfolio_limit||24);
    const portfolioLimit=Math.max(12,Math.min(40,Number.isFinite(requestedLimit)?requestedLimit:24));
    portfolio = selectInsightPortfolio(marketMatchedCandidates, portfolioLimit);
  } catch (error) {
    console.error("betting insight portfolio failed", error);
    portfolio = [...(marketMatchedCandidates||[])]
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
      .slice(0, 24);
  }

  return (portfolio||[]).map((card)=>annotateAirUtility(card,game));
}

export function annotateAirUtility(input, game=null) {
  const card={...input,evidence:input?.evidence?{...input.evidence}:{}};
  const market=card.market||{};
  const sourceScore=finiteAirScore(card.portfolio_score,card.score,55);
  const sample=editorialSampleSize(card);
  const hitRate=editorialHitRate(card);
  const odds=Number(market.odds);
  const realPrice=Number.isFinite(odds)&&odds>1&&market.odds_is_demo===false;
  const implied=realPrice?1/odds:null;
  const gap=realPrice&&Number.isFinite(hitRate)?hitRate-implied:null;
  const analyticalNarrative=isAnalyticalNarrative(card);
  let score=Math.max(25,Math.min(92,sourceScore));
  const reasons=[];

  if(realPrice){
    if(odds<1.30){score-=28;reasons.push(["низкий кэф",-28]);}
    else if(odds<1.40){score-=18;reasons.push(["низкий кэф",-18]);}
    else if(odds<1.55){score-=8;reasons.push(["кэф ниже рабочего",-8]);}
    else if(odds<=2.20){score+=10;reasons.push(["хороший кэф",10]);}
    else if(odds<=2.80){score+=6;reasons.push(["интересный кэф",6]);}
    else if(odds<=4){score+=1;}
    else {score-=4;reasons.push(["высокий риск цены",-4]);}
  }else{
    score-=20;reasons.push(["нет точной линии",-20]);
  }

  if(Number.isFinite(gap)){
    if(gap>=0.12){score+=16;reasons.push(["история заметно сильнее цены",16]);}
    else if(gap>=0.06){score+=9;reasons.push(["история сильнее цены",9]);}
    else if(gap>=0.02){score+=4;reasons.push(["есть запас к цене",4]);}
    else if(gap>=-0.02){reasons.push(["история близка к цене",0]);}
    else if(gap>=-0.07){score-=8;reasons.push(["история слабее цены",-8]);}
    else {score-=15;reasons.push(["история заметно слабее цены",-15]);}
  }

  if(sample>0&&sample<6){score-=10;reasons.push(["малая выборка",-10]);}
  else if(sample<10&&sample>0){score-=3;reasons.push(["небольшая выборка",-3]);}
  else if(sample<=30&&sample>0){score+=6;reasons.push(["понятная выборка",6]);}
  else if(sample<100){score+=3;reasons.push(["солидная выборка",3]);}
  else if(sample>=100){score+=2;reasons.push(["большая выборка",2]);}

  // A large sample is not itself a hit-rate. Historical cards without a
  // measurable pass rate must not float to the top just because they have
  // 82 games attached to them. Advanced cards use rank/mismatch evidence
  // instead, so they are intentionally excluded from this penalty.
  if(!analyticalNarrative&&sample>=30&&!Number.isFinite(hitRate)){
    score-=22;reasons.push(["нет частоты прохода",-22]);
  }
  if(analyticalNarrative){
    score+=4;reasons.push(["advanced matchup",4]);
  }

  const type=String(market.type||"").toLowerCase();
  const line=Number(market.line);
  if(type==="moneyline"){score+=5;reasons.push(["понятный рынок",5]);}
  if(type==="handicap"){
    if(Number.isFinite(line)&&Math.abs(line)>=2.5){score-=5;reasons.push(["слишком безопасная фора",-5]);}
    else if(Number.isFinite(line)&&Math.abs(line)===1.5){score+=2;}
  }
  if(type==="game_total"){
    if(Number.isFinite(line)&&(line===5.5||line===6.5)){score+=3;}
    else if(Number.isFinite(line)&&(line<=4.5||line>=7.5)){score-=5;reasons.push(["крайняя линия",-5]);}
  }
  if(type==="team_total"){
    if(Number.isFinite(line)&&(line===2.5||line===3.5)){score+=3;}
    else if(Number.isFinite(line)&&(line<=1.5||line>=4.5)){score-=5;reasons.push(["крайняя линия",-5]);}
  }
  if(card?.evidence_quality?.context_only){score-=8;reasons.push(["контекст, не прямой сигнал",-8]);}
  if(card?.evidence?.multi_window_confirmed){
    score+=6;reasons.push(["сезон + форма совпадают",6]);
    if(card?.evidence?.venue_confirmed){score+=4;reasons.push(["home/away подтверждает",4]);}
  }
  if(card?.evidence?.advanced_snapshot){
    const rank=Number(card.evidence.rank||card.evidence.team_rank||0);
    const gap=Number(card.evidence.rank_gap||0);
    if(rank>0&&rank<=3){score+=6;reasons.push(["топ-3 НХЛ",6]);}
    else if(rank>0&&rank<=6){score+=4;reasons.push(["топ-6 НХЛ",4]);}
    if(gap>=15){score+=4;reasons.push(["сильный matchup",-0+4]);}
  }
  if(String(card.title||"").length>110){score-=4;reasons.push(["сложная формулировка",-4]);}

  const airScore=Math.max(0,Math.min(100,Math.round(score)));
  const reasonTags=[...reasons]
    .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
    .map(x=>x[0])
    .filter((v,i,a)=>a.indexOf(v)===i)
    .slice(0,3);

  card.air_score=airScore;
  card.air_label=airScore>=85?"СИЛЬНО ДЛЯ ЭФИРА":airScore>=70?"ХОРОШО ДЛЯ ЭФИРА":airScore>=55?"СРЕДНЕ":airScore>=40?"СЛАБО":"НЕ ДЛЯ ЭФИРА";
  card.air_reasons=reasonTags;
  card.air_meta={
    meaning:"editorial_broadcast_utility_not_probability",
    source_score:Math.round(sourceScore*10)/10,
    sample_size:sample||null,
    historical_rate:Number.isFinite(hitRate)?roundAir3(hitRate):null,
    implied_probability:Number.isFinite(implied)?roundAir3(implied):null,
    historical_minus_implied:Number.isFinite(gap)?roundAir3(gap):null,
    real_winline_price:realPrice,
  };
  const formatted=formatBroadcastTitle(card,{sample,hitRate,game});
  const narrative=buildNarrative(
    {...card,broadcast_title:formatted.title,broadcast_detail:formatted.detail},
    {game,sample,hitRate}
  );
  card.broadcast_title=narrative?.tv?.title||formatted.title;
  card.broadcast_variants=Array.isArray(narrative?.tv?.variants)?narrative.tv.variants:[card.broadcast_title];
  if(narrative?.tv?.subtitle)card.broadcast_subtitle=narrative.tv.subtitle;
  card.operator_narrative=narrative?.operator||null;
  if(formatted.detail)card.broadcast_detail=formatted.detail;
  return card;
}

export function formatBroadcastTitle(card, precomputed={}) {
  const evidence=card?.evidence||{};
  const market=card?.market||{};
  const sample=finiteAirNumber(precomputed.sample)??editorialSampleSize(card)??0;
  const rate=finiteAirNumber(precomputed.hitRate);
  const hitRate=rate!==null?rate:editorialHitRate(card);
  const game=precomputed.game||null;
  const original=String(card?.title||card?.value||"").trim();

  // Rank/xG/Corsi/shot-mismatch stories are analytical narratives, not
  // frequencies. Never rewrite them into "X% of games" merely because they
  // also carry a season sample such as 82.
  if(isAnalyticalNarrative(card)){
    return formatAdvancedBroadcastTitle(card,original);
  }
  if(!sample||!Number.isFinite(hitRate))return {title:original,detail:null};

  const type=String(market.type||"").toLowerCase();
  const line=Number(market.line);
  const pct=Math.round(hitRate*100);
  const hits=editorialHitCount(card,sample,hitRate);
  const sampleLabel=sample>=100?String(Math.floor(sample/100)*100)+"+ ИГР":String(sample)+" ИГР";
  const label=String(market.label||"").trim().toUpperCase().replace(/\./g,",");
  let title;

  // A positive hockey handicap is much easier to understand as "didn't lose by N+",
  // while a negative handicap is simply "won by N+". Keep the betting market below
  // the headline, but make the fact itself normal spoken Russian.
  if(type==="handicap"&&Number.isFinite(line)&&line!==0){
    const margin=Math.max(1,Math.floor(Math.abs(line)+0.5));
    const subject=String(market.subject||evidence.team||"").trim().toUpperCase();
    const plain=line>0
      ?(subject?subject+" НЕ ПРОИГРЫВАЛ В "+margin+"+ ШАЙБЫ":"НЕ ПРОИГРЫВАЛ В "+margin+"+ ШАЙБЫ")
      :(subject?subject+" ПОБЕЖДАЛ В "+margin+"+ ШАЙБЫ":"ПОБЕДА В "+margin+"+ ШАЙБЫ");
    title=sample<=30&&Number.isFinite(hits)
      ?plain+" — "+hits+" ИЗ "+sample+" МАТЧЕЙ"
      :plain+" — "+pct+"% МАТЧЕЙ · "+sampleLabel;
  } else if(sample<=30) {
    return {title:original,detail:null};
  } else if(type==="moneyline")title="ПОБЕДА — В "+pct+"% МАТЧЕЙ · "+sampleLabel;
  else if(type==="game_total"||type==="team_total")title=(label||"ТОТАЛ")+" ПРОШЁЛ В "+pct+"% МАТЧЕЙ · "+sampleLabel;
  else title=pct+"% МАТЧЕЙ · "+sampleLabel;

  let detail=null;
  const away=evidence.away,home=evidence.home;
  if(away&&home&&Number.isFinite(Number(away.hits))&&Number.isFinite(Number(away.sample))&&Number.isFinite(Number(home.hits))&&Number.isFinite(Number(home.sample))){
    const awayTeam=String(game?.away_tri||evidence.away_team||card?.away_tri||"ГОСТИ");
    const homeTeam=String(game?.home_tri||evidence.home_team||card?.home_tri||"ХОЗЯЕВА");
    detail=awayTeam+" в гостях "+away.hits+"/"+away.sample+" · "+homeTeam+" дома "+home.hits+"/"+home.sample;
  }else if(sample>=100){
    detail="Точная выборка: "+sample+" игр";
  }
  return {title,detail};
}

function isAnalyticalNarrative(card){
  const category=String(card?.category||"").toLowerCase();
  const evidence=card?.evidence||{};
  return category==="advanced_market"
    || category==="advanced_rolling_venue"
    || category==="advanced_context"
    || evidence.advanced_snapshot===true
    || evidence.multi_window_confirmed===true
    || String(evidence.feature_layer||"").startsWith("advanced_");
}

function formatAdvancedBroadcastTitle(card,original){
  const e=card?.evidence||{};
  const team=String(e.team||card?.market?.subject||"").trim().toUpperCase();
  const opponent=String(e.opponent||"").trim().toUpperCase();
  const teamRank=finiteAirNumber(e.team_rank??e.rank);
  const opponentRank=finiteAirNumber(e.opponent_rank);
  const metric=String(e.metric||"").toLowerCase();
  const opponentMetric=String(e.opponent_metric||"").toLowerCase();

  const metricLabels={
    xgf60:"xG/60",
    xgf_pct:"ДОЛЕ xG",
    cf_pct:"CORSI",
    corsi_pct:"CORSI",
    sf60:"БРОСКАМ",
    hdxgf60:"ОПАСНОМУ xG",
    sd60:"РАЗНИЦЕ БРОСКОВ",
    xgd60:"xG-ДИФФЕРЕНЦИАЛУ",
  };
  const opponentLabels={
    xga60:"xGA/60",
    xgf_pct:"ДОЛЕ xG",
    cf_pct:"CORSI",
    corsi_pct:"CORSI",
    sa60:"ДОПУЩЕННЫМ БРОСКАМ",
    hdxga60:"ОПАСНОМУ xGA",
    sd60:"РАЗНИЦЕ БРОСКОВ",
    xgd60:"xG-ДИФФЕРЕНЦИАЛУ",
  };

  let title=original;
  if(team&&opponent&&teamRank!==null&&opponentRank!==null){
    const left=metricLabels[metric]||metric.toUpperCase()||"ADVANCED-МЕТРИКЕ";
    const right=opponentLabels[opponentMetric]||metricLabels[opponentMetric]||left;
    title=team+" — №"+Math.round(teamRank)+" НХЛ ПО "+left+" · "+opponent+" — №"+Math.round(opponentRank)+" ПО "+right;
  }else if(team&&teamRank!==null&&metric){
    title=team+" — №"+Math.round(teamRank)+" НХЛ ПО "+(metricLabels[metric]||metric.toUpperCase());
  }

  const detail=[];
  const t20=finiteAirNumber(e.rolling_team_rank_20),o20=finiteAirNumber(e.rolling_opponent_rank_20);
  const t10=finiteAirNumber(e.rolling_team_rank_10),o10=finiteAirNumber(e.rolling_opponent_rank_10);
  if(team&&opponent&&t20!==null&&o20!==null)detail.push("Последние 20: "+team+" №"+Math.round(t20)+" · "+opponent+" №"+Math.round(o20));
  if(team&&opponent&&t10!==null&&o10!==null)detail.push("Последние 10: "+team+" №"+Math.round(t10)+" · "+opponent+" №"+Math.round(o10));
  const venueSample=finiteAirNumber(e.venue_sample);
  if(e.venue_confirmed===true&&venueSample!==null)detail.push("Home/away подтверждает · "+Math.round(venueSample)+" матчей на команду");

  return {title,detail:detail.length?detail.join(" · "):null};
}

function editorialSampleSize(card){
  const e=card?.evidence||{};
  const away=finiteAirNumber(e.away?.sample),home=finiteAirNumber(e.home?.sample);
  if(away!==null&&away>0&&home!==null&&home>0)return away+home;
  const candidates=[
    card?.sample,e.sample,e.sample_size,e.window,e.games,
    e.cover?.sample,e.attack?.sample,e.opponent_defense?.sample,
    e.home?.sample,e.away?.sample,
  ].map(finiteAirNumber).filter(v=>v!==null&&v>0);
  return candidates.length?Math.max(...candidates):0;
}
function editorialHitCount(card,sample,hitRate){
  const e=card?.evidence||{};
  const direct=[
    e.hits,e.cover?.hits,e.attack?.hits,e.opponent_defense?.hits,
    e.home?.hits,e.away?.hits,
  ].map(finiteAirNumber).find(v=>v!==null);
  if(direct!==undefined&&direct!==null)return Math.max(0,Math.round(direct));
  if(Number.isFinite(sample)&&sample>0&&Number.isFinite(hitRate))return Math.max(0,Math.round(sample*hitRate));
  return null;
}
function editorialHitRate(card){
  const e=card?.evidence||{};
  const awayRate=firstAirRate(e.away?.hit_rate,e.away?.rate);
  const homeRate=firstAirRate(e.home?.hit_rate,e.home?.rate);
  const awayN=finiteAirNumber(e.away?.sample),homeN=finiteAirNumber(e.home?.sample);
  if(awayRate!==null&&homeRate!==null){
    if(awayN!==null&&homeN!==null&&awayN+homeN>0)return (awayRate*awayN+homeRate*homeN)/(awayN+homeN);
    return (awayRate+homeRate)/2;
  }
  const direct=firstAirRate(
    e.hit_rate,e.average_rate,e.combined_rate,e.rate,e.cover_rate,e.win_rate,
    e.cover?.hit_rate,e.cover?.rate,
    e.attack?.hit_rate,e.attack?.rate,
    e.opponent_defense?.hit_rate,e.opponent_defense?.rate,
    e.home?.hit_rate,e.home?.rate,
    e.away?.hit_rate,e.away?.rate,
  );
  if(direct!==null)return direct;
  const hits=finiteAirNumber(e.hits),sample=firstAirPositiveNumber(e.sample,e.sample_size,e.window);
  if(hits!==null&&sample!==null&&sample>0)return hits/sample;
  const coverHits=finiteAirNumber(e.cover?.hits),coverSample=finiteAirNumber(e.cover?.sample);
  if(coverHits!==null&&coverSample!==null&&coverSample>0)return coverHits/coverSample;
  const wins=finiteAirNumber(e.wins),games=finiteAirNumber(e.games);
  if(wins!==null&&games!==null&&games>0)return wins/games;
  return null;
}
function finiteAirNumber(value){
  if(value===null||value===undefined||value==="")return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}
function firstAirPositiveNumber(...values){
  for(const value of values){const n=finiteAirNumber(value);if(n!==null&&n>0)return n}
  return null;
}
function firstAirRate(...values){
  for(const value of values){
    const n=finiteAirNumber(value);
    if(n!==null&&n>=0&&n<=1)return n;
  }
  return null;
}
function signedAirLine(value){
  const n=Number(value);
  if(!Number.isFinite(n))return"";
  const abs=Math.abs(n).toFixed(1).replace(".",",");
  return (n>0?"+":n<0?"-":"")+abs;
}
function finiteAirScore(...values){for(const value of values){const n=Number(value);if(Number.isFinite(n))return n}return 55}
function roundAir3(value){return Math.round(Number(value)*1000)/1000}

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
