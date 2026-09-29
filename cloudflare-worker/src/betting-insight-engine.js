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
import { buildAdvancedRollingVenueInsights } from "./advanced-rolling-venue-insights.js";
import { buildNarrative } from "./narrative-engine.js";
import { diversifyBroadcastAngles } from "./broadcast-angle-engine.js";
import { buildMarketCombinationInsights } from "./market-combination-engine.js";
import { buildPlayerPropMarketInsights } from "./player-prop-market-insights.js";
import { buildSpecialTeamsMarketInsights } from "./special-teams-market-insights.js";
import { buildExpandedMarketInsights } from "./expanded-market-insights.js";
import { buildProviderMarketHistoryInsights } from "./provider-market-history-insights.js";
import { summarizeMarketCoverage } from "./market-coverage-audit.js";
import { buildH2HBroadcastInsights } from "./h2h-broadcast-insights.js";

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
  const playerPropMarketInsights = await safeInsightBuild("player_prop_markets", () => buildPlayerPropMarketInsights(db, game));
  const specialTeamsInsights = await safeInsightBuild("special_teams", () => buildSpecialTeamsMarketInsights(db, game));
  const expandedMarketInsights = await safeInsightBuild("expanded_markets", () => buildExpandedMarketInsights(db, game));
  const providerHistoryInsights = await safeInsightBuild("provider_exact_history", () => buildProviderMarketHistoryInsights(db, game, options.provider_markets));
  const h2hBroadcastInsights = await safeInsightBuild("h2h_current_lines", () => buildH2HBroadcastInsights(db, game, options.provider_markets));
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
    ...playerPropMarketInsights,
    ...specialTeamsInsights,
    ...expandedMarketInsights,
    ...providerHistoryInsights,
    ...h2hBroadcastInsights,
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

  const requireProviderPrice=options.require_provider_price===true;
  const requestedMinOdds=Number(options.min_provider_odds);
  const minProviderOdds=Number.isFinite(requestedMinOdds)?Math.max(1.01,requestedMinOdds):1.01;
  if(requireProviderPrice){
    marketMatchedCandidates=(marketMatchedCandidates||[]).filter(card=>{
      const market=card?.market||{},odds=Number(market.odds);
      return Number.isFinite(odds)&&odds>=minProviderOdds&&market.odds_is_demo===false&&market.odds_source==="provider_live";
    });
  }

  const generatorDiagnostics={
    base_candidate_count:basePortfolio.length,
    combination_candidate_count:combinationInsights.length,
    raw_candidate_count:rawPortfolio.length,
    matched_candidate_count:(marketMatchedCandidates||[]).length,
    pre_prune_market_coverage:summarizeMarketCoverage(options.provider_markets||[],marketMatchedCandidates||[]),
    require_provider_price:requireProviderPrice,
    min_provider_odds:requireProviderPrice?minProviderOdds:null,
  };

  let portfolio;
  try {
    const requestedLimit=Number(options.portfolio_limit||24);
    const portfolioLimit=Math.max(12,Math.min(64,Number.isFinite(requestedLimit)?requestedLimit:24));
    portfolio = selectInsightPortfolio(marketMatchedCandidates, portfolioLimit);
  } catch (error) {
    console.error("betting insight portfolio failed", error);
    portfolio = [...(marketMatchedCandidates||[])]
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
      .slice(0, 24);
  }

  // Keep H2H as its own editorial story even when the same exact market
  // has a stronger provider-history primary card. The four-card broadcast UI
  // needs two genuine head-to-head choices, not H2H hidden inside support metadata.
  const h2hEditorial=(marketMatchedCandidates||[])
    .filter(isTeamH2HEditorialCard)
    .sort((a,b)=>Number(b?.score||0)-Number(a?.score||0)||Number(b?.evidence?.window||0)-Number(a?.evidence?.window||0))
    .slice(0,4);
  const portfolioForBroadcast=dedupe([...(portfolio||[]),...h2hEditorial]);

  const recentBroadcastHeadlines=await loadRecentBroadcastHeadlines(db);
  const airAnnotated=portfolioForBroadcast.map((card)=>annotateAirUtility(card,game));
  const mathSafe=airAnnotated.filter(card=>card?.broadcast_math_valid!==false);
  generatorDiagnostics.suppressed_math_invalid_count=Math.max(0,airAnnotated.length-mathSafe.length);
  const diversified=diversifyBroadcastAngles(
    mathSafe,
    {recent_headlines:recentBroadcastHeadlines}
  );
  const semanticSafe=diversified.filter(card=>broadcastCardSemanticsValid(card,game));
  generatorDiagnostics.suppressed_semantic_invalid_count=Math.max(0,diversified.length-semanticSafe.length);
  const annotated=resolveContradictoryAdvice(semanticSafe);
  generatorDiagnostics.recent_broadcast_headline_count=recentBroadcastHeadlines.length;
  generatorDiagnostics.suppressed_contradictory_count=Math.max(0,diversified.length-annotated.length);
  generatorDiagnostics.final_portfolio_count=annotated.length;
  generatorDiagnostics.post_prune_market_coverage=summarizeMarketCoverage(options.provider_markets||[],annotated);
  if(options.generator_diagnostics&&typeof options.generator_diagnostics==="object"){
    Object.assign(options.generator_diagnostics,generatorDiagnostics);
  }
  return annotated;
}

export function annotateAirUtility(input, game=null) {
  const card={...input,evidence:input?.evidence?{...input.evidence}:{}};
  card.market={...(card.market||{}),label:broadcastMarketLabel(card.market||{})};
  const market=card.market||{};
  const sourceScore=finiteAirScore(card.portfolio_score,card.score,55);
  const stats=editorialStats(card);
  const sample=stats.sample;
  const hitRate=stats.rate;
  const odds=Number(market.odds);
  const realPrice=Number.isFinite(odds)&&odds>1&&market.odds_is_demo===false;
  const implied=realPrice?1/odds:null;
  const credibility=sample>0?sample/(sample+12):0;
  const adjustedRate=Number.isFinite(hitRate)?0.5+(hitRate-0.5)*credibility:null;
  const adjustedGap=realPrice&&Number.isFinite(adjustedRate)?adjustedRate-implied:null;
  const rawGap=realPrice&&Number.isFinite(hitRate)?hitRate-implied:null;
  const analyticalNarrative=isAnalyticalNarrative(card);
  const reasons=[];

  // AIR SCORE is editorial usefulness + evidence/value quality, not probability.
  // Start from a neutral base. Upstream generator scores are only a small signal,
  // otherwise dozens of cards saturate at 100.
  let score=38+Math.max(-4,Math.min(4,(sourceScore-50)*0.08));

  if(card?.evidence?.requires_start_confirmation===true){
    score-=14;reasons.push(["вратарь не подтверждён",-14]);
  }

  if(realPrice){
    if(odds<1.30){score-=14;reasons.push(["слишком низкий кэф",-14]);}
    else if(odds<1.45){score-=8;reasons.push(["низкий кэф",-8]);}
    else if(odds<=2.40){score+=4;reasons.push(["рабочий кэф",4]);}
    else if(odds<=3.50){score+=2;reasons.push(["интересная цена",2]);}
    else if(odds>5){score-=4;reasons.push(["очень высокий кэф",-4]);}
  }else{
    score-=18;reasons.push(["нет точной линии",-18]);
  }

  if(sample>0){
    if(sample<6){score+=0;reasons.push(["очень малая выборка",-8]);}
    else if(sample<10){score+=2;reasons.push(["малая выборка",-5]);}
    else if(sample<20){score+=8;reasons.push(["рабочая выборка",4]);}
    else if(sample<40){score+=13;reasons.push(["хорошая выборка",6]);}
    else if(sample<80){score+=17;reasons.push(["сильная выборка",8]);}
    else {score+=19;reasons.push(["большая выборка",8]);}
  }

  if(Number.isFinite(hitRate)){
    const trend=(hitRate-0.5)*35;
    score+=Math.max(-14,Math.min(16,trend));
    if(hitRate>=0.75)reasons.push(["высокая историческая частота",8]);
    else if(hitRate>=0.65)reasons.push(["сильная историческая частота",6]);
    else if(hitRate<=0.50)reasons.push(["сама история не даёт перевеса",-5]);
  }else if(!analyticalNarrative){
    score-=12;reasons.push(["нет частоты прохода",-12]);
  }

  // Compare the quote to a sample-shrunk historical rate. This prevents 3/6
  // from being treated like 50% known with the same certainty as 40/80.
  if(Number.isFinite(adjustedGap)){
    if(adjustedGap>=0.18){score+=22;reasons.push(["сильный запас к цене",12]);}
    else if(adjustedGap>=0.12){score+=16;reasons.push(["заметный запас к цене",9]);}
    else if(adjustedGap>=0.08){score+=11;reasons.push(["есть запас к цене",7]);}
    else if(adjustedGap>=0.04){score+=6;reasons.push(["небольшой запас к цене",4]);}
    else if(adjustedGap>=0){score+=1;reasons.push(["цена почти без запаса",0]);}
    else if(adjustedGap>=-0.05){score-=7;reasons.push(["цена не лучше истории",-7]);}
    else {score-=14;reasons.push(["цена хуже истории",-14]);}
  }

  const type=String(market.type||"").toLowerCase();
  const line=Number(market.line);
  if(["moneyline","period_1_result","period_2_result","period_3_result"].includes(type)){
    score+=2;reasons.push(["понятный исход",2]);
  }
  if(type==="handicap"){
    if(Number.isFinite(line)&&Math.abs(line)>=2.5){score-=4;reasons.push(["крайняя фора",-4]);}
    if(Number.isFinite(line)&&line===0){score+=1;}
  }
  if(type==="game_total"&&Number.isFinite(line)&&(line<=4.5||line>=7.5)){
    score-=3;reasons.push(["крайняя линия",-3]);
  }
  if(type==="team_total"&&Number.isFinite(line)&&(line<=1.5||line>=4.5)){
    score-=3;reasons.push(["крайняя линия",-3]);
  }
  if(card?.evidence_quality?.context_only){score-=7;reasons.push(["контекст, не прямой сигнал",-7]);}

  const independentSupport=Math.max(
    Number(card?.evidence?.independent_support_count||0),
    Math.max(0,Number(card?.evidence?.combination_support_count||0)-1),
    Array.isArray(card?.evidence?.supporting_signals)?card.evidence.supporting_signals.length:0
  );
  if(card?.evidence?.multi_window_confirmed){score+=5;reasons.push(["форма и длинный отрезок совпадают",5]);}
  if(card?.evidence?.venue_confirmed){score+=3;reasons.push(["дом/выезд подтверждает",3]);}
  if(independentSupport>=1){
    const bonus=Math.min(6,independentSupport*2);
    score+=bonus;reasons.push(["есть независимое подтверждение",bonus]);
  }

  if(analyticalNarrative){
    const rank=Number(card.evidence.rank||card.evidence.team_rank||0);
    const rankGap=Number(card.evidence.rank_gap||0);
    if(rank>0&&rank<=3){score+=8;reasons.push(["топ-3 НХЛ",8]);}
    else if(rank>0&&rank<=6){score+=5;reasons.push(["топ-6 НХЛ",5]);}
    if(rankGap>=15){score+=6;reasons.push(["сильный контраст команд",6]);}
    else if(rankGap>=8){score+=3;reasons.push(["заметный контраст команд",3]);}
  }

  if(String(card.title||"").length>110){score-=4;reasons.push(["сложная формулировка",-4]);}

  // Hard ceilings express uncertainty. A six-game split can still be useful at
  // a very good price, but it cannot look as reliable as a 40-80 game signal.
  let ceiling=96;
  if(Number.isFinite(hitRate)){
    if(sample<6)ceiling=62;
    else if(sample<8)ceiling=68;
    else if(sample<10)ceiling=72;
    else if(sample<15)ceiling=79;
    else if(sample<20)ceiling=84;
    else if(sample<30)ceiling=89;
  }else if(analyticalNarrative){
    ceiling=90;
  }else{
    ceiling=74;
  }

  const exceptional=realPrice
    && sample>=40
    && Number.isFinite(hitRate)&&hitRate>=0.72
    && Number.isFinite(adjustedGap)&&adjustedGap>=0.12
    && (independentSupport>=2||card?.evidence?.multi_window_confirmed===true)
    && card?.evidence_quality?.context_only!==true;
  if(exceptional)ceiling=100;
  else ceiling=Math.min(ceiling,96);

  const airScore=Math.max(0,Math.min(ceiling,Math.round(score)));
  const reasonTags=[...reasons]
    .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
    .map(x=>x[0])
    .filter((v,i,a)=>a.indexOf(v)===i)
    .slice(0,3);

  card.air_score=airScore;
  card.air_label=airScore>=97?"РЕДКАЯ НАХОДКА":airScore>=85?"СИЛЬНО ДЛЯ ЭФИРА":airScore>=70?"ХОРОШО ДЛЯ ЭФИРА":airScore>=55?"СРЕДНЕ":airScore>=40?"СЛАБО":"НЕ ДЛЯ ЭФИРА";
  card.air_reasons=reasonTags;
  card.air_meta={
    meaning:"editorial_broadcast_utility_not_probability",
    source_score:Math.round(sourceScore*10)/10,
    sample_size:sample||null,
    sample_credibility:roundAir3(credibility),
    historical_rate:Number.isFinite(hitRate)?roundAir3(hitRate):null,
    credibility_adjusted_rate:Number.isFinite(adjustedRate)?roundAir3(adjustedRate):null,
    implied_probability:Number.isFinite(implied)?roundAir3(implied):null,
    raw_historical_minus_implied:Number.isFinite(rawGap)?roundAir3(rawGap):null,
    adjusted_historical_minus_implied:Number.isFinite(adjustedGap)?roundAir3(adjustedGap):null,
    score_ceiling:ceiling,
    exceptional_match:Boolean(exceptional),
    real_winline_price:realPrice,
    stats_verified:stats.verified,
    stats_source:stats.source,
    stats_rate_corrected:stats.rate_corrected,
    stats_reported_rate:stats.reported_rate,
    stats_hits:stats.hits,
    stats_consistent:stats.consistent,
  };
  const frequencyClaim=hasFrequencyClaim(card);
  const frequencyCapable=Number.isFinite(hitRate)&&sample>0;
  const semanticStatsOk=frequencyStatsSemanticallyValid(card,stats);
  card.broadcast_math_valid=stats.consistent!==false&&(isAnalyticalNarrative(card)||!frequencyCapable||(stats.verified===true&&semanticStatsOk));
  if(frequencyClaim&&(!semanticStatsOk||stats.verified!==true)&&!isAnalyticalNarrative(card))card.broadcast_math_valid=false;
  const formatted=formatBroadcastTitle(card,{sample,hitRate,hits:stats.hits,stats,game});
  const narrative=buildNarrative(
    {...card,broadcast_title:formatted.title,broadcast_detail:formatted.detail},
    {game,sample,hitRate}
  );
  card.broadcast_title=narrative?.tv?.title||formatted.title;
  card.broadcast_variants=Array.isArray(narrative?.tv?.variants)?narrative.tv.variants:[card.broadcast_title];
  card.broadcast_angle_variants=Array.isArray(narrative?.tv?.angle_variants)?narrative.tv.angle_variants:[];
  card.broadcast_angle_id=narrative?.tv?.angle_id||null;
  card.broadcast_angle_family=narrative?.tv?.angle_family||null;
  card.broadcast_angle_reason=narrative?.tv?.angle_reason||null;
  if(narrative?.tv?.subtitle)card.broadcast_subtitle=narrative.tv.subtitle;
  card.operator_narrative=narrative?.operator||null;
  if(formatted.detail)card.broadcast_detail=formatted.detail;
  return card;
}

export function formatBroadcastTitle(card, precomputed={}) {
  const evidence=card?.evidence||{};
  const market=card?.market||{};
  const stats=precomputed.stats||editorialStats(card);
  const sample=finiteAirNumber(precomputed.sample)??stats.sample??0;
  const rate=finiteAirNumber(precomputed.hitRate);
  const hitRate=rate!==null?rate:stats.rate;
  const hitsPre=finiteAirNumber(precomputed.hits);
  const hits=hitsPre!==null?Math.round(hitsPre):stats.hits;
  const game=precomputed.game||null;
  const original=String(card?.title||card?.value||"").trim();

  // Rank/xG/Corsi/shot-mismatch stories are analytical narratives, not
  // frequencies. Never rewrite them into "X% of games" merely because they
  // also carry a season sample such as 82.
  if(isAnalyticalNarrative(card)){
    return formatAdvancedBroadcastTitle(card,original);
  }
  if(!sample||!Number.isFinite(hitRate)||stats.consistent===false)return {title:original,detail:null};

  const type=String(market.type||"").toLowerCase();
  const line=Number(market.line);
  const pct=Math.round(hitRate*100);
  const label=broadcastMarketLabel(market).toUpperCase().replace(/\./g,",");
  let title;

  // Period/result and small-sample cards must still be spoken Russian.
  // Never leak internal keys such as PERIOD_1_RESULT into the plaque.
  const periodMatch=/^period_([123])_result$/.exec(type);
  if(periodMatch&&Number.isFinite(hits)){
    const periodNo=Number(periodMatch[1]);
    const subject=String(market.subject||evidence.team||"КОМАНДА").trim().toUpperCase();
    const h2h=String(evidence.split||"").toLowerCase()==="h2h";
    title=periodNo+"-Й ПЕРИОД: "+subject+" ПОБЕЖДАЛ В "+hits+" ИЗ "+sample+(h2h?" ОЧНЫХ":"")+" МАТЧЕЙ";
    const odds=Number(market.odds);
    const detail=Number.isFinite(odds)&&odds>1
      ?"Кэф "+odds.toFixed(2).replace(".",",")+" · порог цены "+Math.round(100/odds)+"%"
      :null;
    return {title,detail};
  }
  if(type==="handicap"&&Number.isFinite(line)&&line===0&&sample<=30&&Number.isFinite(hits)){
    const subject=String(market.subject||evidence.team||"КОМАНДА").trim().toUpperCase();
    const h2h=String(evidence.split||"").toLowerCase()==="h2h";
    return {title:subject+" С ФОРОЙ 0 — "+hits+" ИЗ "+sample+(h2h?" ОЧНЫХ":"")+" МАТЧЕЙ",detail:null};
  }

  // A positive hockey handicap is much easier to understand as "didn't lose by N+",
  // while a negative handicap is simply "won by N+". Keep the betting market below
  // the headline, but make the fact itself normal spoken Russian.
  if(type==="handicap"&&Number.isFinite(line)&&line!==0){
    const margin=Math.max(1,Math.floor(Math.abs(line)+0.5));
    const subject=String(market.subject||evidence.team||"").trim().toUpperCase();
    const plain=line>0
      ?(subject?subject+" НЕ ПРОИГРЫВАЛ В "+margin+"+ ШАЙБЫ":"НЕ ПРОИГРЫВАЛ В "+margin+"+ ШАЙБЫ")
      :(subject?subject+" ПОБЕЖДАЛ В "+margin+"+ ШАЙБЫ":"ПОБЕДА В "+margin+"+ ШАЙБЫ");
    if(Number.isFinite(hits))title=plain+" — "+hits+" ИЗ "+sample+" МАТЧЕЙ";
    else return {title:original,detail:null};
  } else if(type==="moneyline"&&Number.isFinite(hits)){
    const subject=String(market.subject||evidence.team||"КОМАНДА").trim().toUpperCase();
    title=subject+" — "+hits+" ПОБЕД В "+sample+" МАТЧАХ";
  } else if((type==="game_total"||type==="team_total")&&Number.isFinite(hits)){
    title=(label||"ТОТАЛ")+" — "+hits+" ИЗ "+sample+" МАТЧЕЙ";
  } else if(Number.isFinite(hits)){
    title=(label||original)+" — "+hits+" ИЗ "+sample+" МАТЧЕЙ";
  } else {
    return {title:original,detail:null};
  }

  let detail=null;
  const away=evidence.away,home=evidence.home;
  if(away&&home&&Number.isFinite(Number(away.hits))&&Number.isFinite(Number(away.sample))&&Number.isFinite(Number(home.hits))&&Number.isFinite(Number(home.sample))){
    const awayTeam=String(game?.away_tri||evidence.away_team||card?.away_tri||"ГОСТИ");
    const homeTeam=String(game?.home_tri||evidence.home_team||card?.home_tri||"ХОЗЯЕВА");
    detail=awayTeam+" в гостях "+away.hits+"/"+away.sample+" · "+homeTeam+" дома "+home.hits+"/"+home.sample;
  }else if(sample>=40&&Number.isFinite(hits)){
    detail="Точная выборка: "+hits+" из "+sample+" матчей";
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

function editorialStats(card){
  const e=card?.evidence||{};
  const direct=exactStats(e.hits,firstAirPositiveNumber(e.decisions,e.sample,e.sample_size,e.games,e.window),e.hit_rate,"evidence");
  if(direct)return direct;
  for(const [name,obj] of [["cover",e.cover],["attack",e.attack],["opponent_defense",e.opponent_defense]]){
    const pair=exactStats(obj?.hits,firstAirPositiveNumber(obj?.decisions,obj?.sample,obj?.games,obj?.window),firstAirRate(obj?.hit_rate,obj?.rate),name);
    if(pair)return pair;
  }
  const away=exactStats(e.away?.hits,firstAirPositiveNumber(e.away?.decisions,e.away?.sample,e.away?.games),firstAirRate(e.away?.hit_rate,e.away?.rate),"away");
  const home=exactStats(e.home?.hits,firstAirPositiveNumber(e.home?.decisions,e.home?.sample,e.home?.games),firstAirRate(e.home?.hit_rate,e.home?.rate),"home");
  if(away&&home){
    const hits=away.hits+home.hits,sample=away.sample+home.sample;
    return {hits,sample,rate:hits/sample,verified:true,consistent:away.consistent&&home.consistent,source:"away+home",rate_corrected:away.rate_corrected||home.rate_corrected,reported_rate:null};
  }
  const wins=exactStats(e.wins,firstAirPositiveNumber(e.games,e.sample),e.win_rate,"wins");
  if(wins)return wins;
  const rateOnly=pairedRateStats(e.hit_rate,firstAirPositiveNumber(e.decisions,e.sample,e.sample_size,e.games,e.window),"evidence_rate")
    ||pairedRateStats(e.cover?.hit_rate,firstAirPositiveNumber(e.cover?.decisions,e.cover?.sample,e.cover?.games),"cover_rate")
    ||pairedRateStats(e.attack?.hit_rate,firstAirPositiveNumber(e.attack?.decisions,e.attack?.sample,e.attack?.games),"attack_rate")
    ||pairedRateStats(e.opponent_defense?.hit_rate,firstAirPositiveNumber(e.opponent_defense?.decisions,e.opponent_defense?.sample,e.opponent_defense?.games),"opponent_defense_rate");
  return rateOnly||{hits:null,sample:0,rate:null,verified:false,consistent:true,source:null,rate_corrected:false,reported_rate:null};
}
function exactStats(hitsValue,sampleValue,reportedRateValue,source){
  const hits=finiteAirNumber(hitsValue),sample=finiteAirNumber(sampleValue),reported=firstAirRate(reportedRateValue);
  if(hits===null||sample===null)return null;
  const h=Math.round(hits),s=Math.round(sample);
  if(s<=0||h<0||h>s)return {hits:h,sample:s,rate:null,verified:false,consistent:false,source,rate_corrected:false,reported_rate:reported};
  const rate=h/s,corrected=reported!==null&&Math.abs(reported-rate)>0.005;
  return {hits:h,sample:s,rate,verified:true,consistent:true,source,rate_corrected:corrected,reported_rate:reported};
}
function pairedRateStats(rateValue,sampleValue,source){
  const rate=firstAirRate(rateValue),sample=finiteAirNumber(sampleValue);
  if(rate===null||sample===null||sample<=0)return null;
  return {hits:null,sample:Math.round(sample),rate,verified:false,consistent:true,source,rate_corrected:false,reported_rate:rate};
}
function frequencyStatsSemanticallyValid(card,stats){
  if(!stats?.verified)return false;
  const e=card?.evidence||{},m=card?.market||{},type=String(m.type||"").toLowerCase(),source=String(stats.source||"");
  if(source==="evidence"&&e.hits!==null&&e.hits!==undefined&&Number(stats.sample)>0)return true;
  if(source==="wins"&&type==="moneyline"){
    const team=String(e.team||m.subject||"").toUpperCase(),subject=String(m.subject||"").toUpperCase();
    return Boolean(subject)&&team===subject;
  }
  return false;
}
function broadcastPeriodLabel(v){const p=String(v||"GAME").toUpperCase();return p==="P1"?"1-Й ПЕРИОД · ":p==="P2"?"2-Й ПЕРИОД · ":p==="P3"?"3-Й ПЕРИОД · ":p==="REG"?"60 МИНУТ · ":""}
function broadcastMarketLabel(m={}){
  const type=String(m.type||"").toLowerCase(),subject=String(m.subject||"").toUpperCase(),side=String(m.side||"").toLowerCase(),period=broadcastPeriodLabel(m.period);
  const ln=finiteAirNumber(m.line),num=ln===null?"":String(Math.round(ln*100)/100).replace(".",","),signed=ln===null?"":(ln>0?"+":"")+num;
  if(type==="moneyline")return (period+"ПОБЕДА "+subject).trim();
  const pm=/^period_([123])_result$/.exec(type);if(pm)return pm[1]+"-Й ПЕРИОД · ПОБЕДА "+subject;
  if(type==="handicap")return (period+subject+" · ФОРА "+signed).trim();
  if(type==="game_total")return (period+(side==="under"?"ТОТАЛ МЕНЬШЕ ":"ТОТАЛ БОЛЬШЕ ")+num).trim();
  if(type==="team_total")return (period+subject+" · "+(side==="under"?"ТОТАЛ КОМАНДЫ МЕНЬШЕ ":"ТОТАЛ КОМАНДЫ БОЛЬШЕ ")+num).trim();
  if(type==="double_chance")return (period+(side==="no_draw"?"БЕЗ НИЧЬЕЙ":subject+" ИЛИ НИЧЬЯ")).trim();
  if(type==="both_teams_score")return side==="yes"?"ОБЕ КОМАНДЫ ЗАБЬЮТ":"ОБЕ КОМАНДЫ НЕ ЗАБЬЮТ";
  if(type==="first_goal_team")return "ПЕРВЫЙ ГОЛ · "+subject;
  if(type==="next_goal_team")return "СЛЕДУЮЩИЙ ГОЛ · "+subject;
  return humanizeBroadcastText(m.label||[period,type,subject,side,num].filter(Boolean).join(" "));
}
function humanizeBroadcastText(value){
  return String(value||"").replace(/\bP1\b/gi,"1-Й ПЕРИОД").replace(/\bP2\b/gi,"2-Й ПЕРИОД").replace(/\bP3\b/gi,"3-Й ПЕРИОД")
    .replace(/\bPERIOD_1_RESULT\b/gi,"ПОБЕДА В 1-М ПЕРИОДЕ").replace(/\bPERIOD_2_RESULT\b/gi,"ПОБЕДА В 2-М ПЕРИОДЕ").replace(/\bPERIOD_3_RESULT\b/gi,"ПОБЕДА В 3-М ПЕРИОДЕ")
    .replace(/\bDOUBLE_CHANCE\b/gi,"ДВОЙНОЙ ШАНС").replace(/\bTEAM_OR_DRAW\b/gi,"КОМАНДА ИЛИ НИЧЬЯ").replace(/\bNO_DRAW\b/gi,"БЕЗ НИЧЬЕЙ")
    .replace(/(^|[\s·—:])ТМ(?=\s|$)/gi,"$1ТОТАЛ МЕНЬШЕ").replace(/(^|[\s·—:])ТБ(?=\s|$)/gi,"$1ТОТАЛ БОЛЬШЕ").replace(/\s+/g," ").trim().toUpperCase();
}
export function broadcastCardSemanticsValid(card,game={}){
  if(!card||card.broadcast_math_valid===false)return false;
  const m=card.market||{},e=card.evidence||{},title=String(card.broadcast_title||card.title||"");
  if(/\b(?:P[123]|PERIOD_[123]_RESULT|DOUBLE_CHANCE|TEAM_OR_DRAW|NO_DRAW)\b/i.test(title+" "+String(m.label||"")))return false;
  const type=String(m.type||"").toLowerCase(),mp=String(m.period||"GAME").toUpperCase();
  const tm=/([123])-Й ПЕРИОД/i.exec(title),titlePeriod=tm?"P"+tm[1]:null;
  const typePeriod=/^period_([123])_result$/.exec(type),expected=typePeriod?"P"+typePeriod[1]:/^(P[123])$/.test(mp)?mp:null;
  if(titlePeriod&&expected&&titlePeriod!==expected)return false;
  const team=String(e.team||m.subject||"").toUpperCase(),opponent=String(e.opponent||"").toUpperCase();
  if(String(e.split||"").toLowerCase()==="h2h"&&team&&opponent){
    if(team===opponent)return false;
    const home=String(game.home_tri||"").toUpperCase(),away=String(game.away_tri||"").toUpperCase(),wanted=team===home?away:team===away?home:"";
    if(wanted&&opponent!==wanted)return false;
  }
  return true;
}
function hasFrequencyClaim(card){
  const text=String(card?.broadcast_title||card?.title||card?.value||"").toUpperCase();
  return /\d+\s*%|\d+\s+ИЗ\s+\d+|\d+\s+МАТЧ(?:А|ЕЙ)?\s+ПОДРЯД|\d+\+?\s+ИГР/.test(text);
}
function editorialSampleSize(card){return editorialStats(card).sample||0}
function editorialHitCount(card,sample,hitRate){
  const stats=editorialStats(card);
  if(stats.verified&&Number.isFinite(stats.hits))return stats.hits;
  return null;
}
function editorialHitRate(card){return editorialStats(card).rate}
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

export function resolveContradictoryAdvice(cards=[]){
  const sorted=[...(cards||[])].sort((a,b)=>Number(b?.air_score||0)-Number(a?.air_score||0));
  const accepted=[],winners=new Map();
  for(const card of sorted){
    const conflict=hardConflictIdentity(card);
    if(!conflict){accepted.push(card);continue}
    const prior=winners.get(conflict.key);
    if(!prior){
      winners.set(conflict.key,{direction:conflict.direction,card});
      accepted.push(card);
      continue;
    }
    if(prior.direction===conflict.direction){
      accepted.push(card);
      continue;
    }
    // Same exact two-way proposition, opposite direction: keep only the
    // stronger editorial/value case. Do not tell the operator both sides.
    card.suppressed_reason="opposite_market_direction";
  }
  return accepted;
}

function hardConflictIdentity(card){
  const m=card?.market||{},type=String(m.type||"").toLowerCase(),period=String(m.period||"GAME").toUpperCase();
  const subject=String(m.subject||"").toUpperCase(),side=String(m.side||"").toLowerCase();
  const line=finiteAirNumber(m.line);
  if(["moneyline","period_1_result","period_2_result","period_3_result","next_goal_team","first_goal_team"].includes(type)){
    if(!subject)return null;
    return {key:type+"|"+period,direction:subject};
  }
  if(type==="game_total"&&line!==null&&["over","under"].includes(side)){
    return {key:type+"|"+period+"|"+line.toFixed(2),direction:side};
  }
  if(type==="team_total"&&subject&&line!==null&&["over","under"].includes(side)){
    return {key:type+"|"+period+"|"+subject+"|"+line.toFixed(2),direction:side};
  }
  if(type==="handicap"&&subject&&line!==null){
    return {key:type+"|"+period+"|"+Math.abs(line).toFixed(2),direction:subject+"|"+Math.sign(line)};
  }
  return null;
}

function isTeamH2HEditorialCard(card){
  const category=String(card?.category||"").toLowerCase();
  const type=String(card?.insight_type||"").toLowerCase();
  const split=String(card?.evidence?.split||"").toLowerCase();
  if(category==="player_h2h"||type.includes("player"))return false;
  return split==="h2h"||category==="h2h_market"||type==="h2h_dominance"||type.startsWith("h2h_");
}

async function loadRecentBroadcastHeadlines(db){
  if(!db)return[];
  try{
    const result=await db.prepare(`
      SELECT headline_ru
      FROM broadcast_operator_actions
      WHERE action='shown'
        AND headline_ru IS NOT NULL
        AND TRIM(headline_ru)<>''
        AND datetime(created_at)>=datetime('now','-14 days')
      ORDER BY id DESC
      LIMIT 120;
    `).all();
    return (result?.results||[]).map(x=>String(x.headline_ru||"").trim()).filter(Boolean);
  }catch(error){
    console.error("recent broadcast headline history unavailable",error);
    return[];
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
  for(const card of cards||[]){
    if(!card)continue;
    const market=card.market||{};
    const line=market.line===null||market.line===undefined||market.line===""?"none":Number.isFinite(Number(market.line))?Number(market.line).toFixed(2):String(market.line);
    // Generated cards already carry stable IDs that encode market/line/window/source.
    // Preserve them here; exact-market consolidation belongs to insight-portfolio,
    // not this early candidate-pool stage.
    const key=card.id
      ? `id:${card.id}`
      : [
          card.category||card.insight_type||"unknown",
          card.insight_type||"unknown",
          market.type||"unknown",
          market.period||"GAME",
          market.subject||"all",
          market.side||"none",
          line,
        ].join(":");
    const current=m.get(key);
    if(!current||Number(current.score||0)<Number(card.score||0))m.set(key,card);
  }
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
