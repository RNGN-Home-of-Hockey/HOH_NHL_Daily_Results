import { fetchNhlJson } from "./data-core-importer.js";
import { withDemoOdds } from "./demo-winline-odds.js";
import { applyWinlineMarkets } from "./winline-market-adapter.js";
import { buildNarrative } from "./narrative-engine.js";

const NHL_BASE = "https://api-web.nhle.com/v1";
const SHOT_TYPES = new Set(["shot-on-goal", "goal"]);

export async function buildLiveGameSnapshot(gamePk, fetchImpl = fetch) {
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) {
    throw new Error("game_pk must be a positive integer");
  }

  const payload = await fetchNhlJson(
    fetchImpl,
    `${NHL_BASE}/gamecenter/${gamePk}/play-by-play`,
    { timeoutMs: 12000, maxAttempts: 2 },
  );

  const home = payload.homeTeam || {};
  const away = payload.awayTeam || {};
  const teamsById = new Map([
    [Number(home.id), String(home.abbrev || "").toUpperCase()],
    [Number(away.id), String(away.abbrev || "").toUpperCase()],
  ]);
  const game = {
    game_pk: Number(payload.id || gamePk),
    season_id: String(payload.season || ""),
    game_type: Number(payload.gameType || 0),
    game_state: String(payload.gameState || "").toUpperCase(),
    home_tri: String(home.abbrev || "").toUpperCase(),
    away_tri: String(away.abbrev || "").toUpperCase(),
    home_score: numberOrZero(home.score),
    away_score: numberOrZero(away.score),
    home_sog: nullableNumber(home.sog),
    away_sog: nullableNumber(away.sog),
    period_number: nullableNumber(payload.periodDescriptor?.number),
    period_type: payload.periodDescriptor?.periodType || null,
    time_remaining: payload.clock?.timeRemaining || null,
    seconds_remaining: nullableNumber(payload.clock?.secondsRemaining),
    running: Boolean(payload.clock?.running),
    in_intermission: Boolean(payload.clock?.inIntermission),
  };

  const shots = [];
  const rawStats={
    [game.away_tri]:{hits:0,pim:0,faceoff_wins:0},
    [game.home_tri]:{hits:0,pim:0,faceoff_wins:0},
  };
  let faceoffs=0;
  for (const play of payload.plays || []) {
    const teamId = Number(play.details?.eventOwnerTeamId);
    const teamTri = teamsById.get(teamId);
    if (teamTri && play.typeDescKey === "hit") rawStats[teamTri].hits += 1;
    if (teamTri && play.typeDescKey === "penalty") rawStats[teamTri].pim += Math.max(0,Number(play.details?.duration)||0);
    if (teamTri && play.typeDescKey === "faceoff") { rawStats[teamTri].faceoff_wins += 1; faceoffs += 1; }
    if (!SHOT_TYPES.has(play.typeDescKey) || !teamTri) continue;
    shots.push({
      sort_order: Number(play.sortOrder ?? play.eventId ?? 0),
      event_type: play.typeDescKey,
      team_tri: teamTri,
      period_number: Number(play.periodDescriptor?.number || 0),
      period_type: play.periodDescriptor?.periodType || null,
      time_in_period: play.timeInPeriod || null,
      elapsed_seconds: gameElapsedSeconds(play),
    });
  }
  const playShots=teamCounts(shots,game);
  const statFor=(tri,sog)=>({
    team_tri:tri,
    shots:Number.isFinite(Number(sog))?Number(sog):Number(playShots[tri]||0),
    hits:Number(rawStats[tri]?.hits||0),
    pim:Number(rawStats[tri]?.pim||0),
    faceoff_pct:faceoffs>0?round3(Number(rawStats[tri]?.faceoff_wins||0)/faceoffs):null,
  });
  const liveStats={away:statFor(game.away_tri,game.away_sog),home:statFor(game.home_tri,game.home_sog)};
  const liveContext=buildLiveContext(game,shots);

  const cards = buildLiveCards(game, shots);
  return {
    ok: true,
    source: "nhl_live_play_by_play",
    fetched_at: new Date().toISOString(),
    game,
    live_stats:liveStats,
    live_context:liveContext,
    shot_events: shots.length,
    cards,
  };
}

export function attachLiveWinlineMarkets(snapshot, providerMarkets, options={}) {
  if(!snapshot?.game||!Array.isArray(snapshot.cards))return snapshot;
  const liveMarkets=(providerMarkets||[]).filter(m=>m?.is_live===true||Number(m?.is_live||0)===1);
  const maxAgeMs=options.market_max_age_ms||5*60*1000;
  let exact=[];
  try{
    exact=applyWinlineMarkets(snapshot.cards,liveMarkets,{now:options.now,max_age_ms:maxAgeMs});
  }catch(error){
    console.error("live Winline market adapter failed",error);
    exact=[];
  }
  const fallback=buildProviderDrivenLiveCards(snapshot,liveMarkets,exact,{now:options.now,max_age_ms:maxAgeMs});
  let cards=[...exact,...fallback];
  const seen=new Set();
  cards=cards.filter(card=>{const key=String(card?.market?.market_id||card?.market?.selection_id||card?.id||"");if(!key||seen.has(key))return false;seen.add(key);return true});
  cards=cards.map(card=>{
    const narrative=buildNarrative(card,{game:snapshot.game});
    return {
      ...card,
      broadcast_title:card.broadcast_title||narrative?.tv?.title||card.title,
      broadcast_variants:narrative?.tv?.variants||[card.title],
      broadcast_subtitle:card.broadcast_subtitle||narrative?.tv?.subtitle||null,
      operator_narrative:narrative?.operator||null,
      air_score:Math.max(0,Math.min(100,Math.round(Number(card.air_score??card.score??0)))),
      air_label:"LIVE",
      air_reasons:card.air_reasons||["live pressure","реальная линия"],
    };
  }).sort((a,b)=>Number(b.air_score||b.score||0)-Number(a.air_score||a.score||0)).slice(0,10);
  const newestLiveQuote=liveMarkets.map(m=>Date.parse(String(m?.updated_at||""))).filter(Number.isFinite).sort((a,b)=>b-a)[0]||null;
  return {...snapshot,cards,provider_market_count:liveMarkets.length,priced_live_cards:cards.length,provider_live_updated_at:newestLiveQuote?new Date(newestLiveQuote).toISOString():null};
}

export function buildProviderDrivenLiveCards(snapshot,liveMarkets,existing=[],options={}){
  const game=snapshot?.game||{},ctx=snapshot?.live_context||{},nowMs=resolveLiveNow(options.now),maxAgeMs=Number(options.max_age_ms)||5*60*1000;
  const used=new Set((existing||[]).map(c=>String(c?.market?.market_id||c?.market?.selection_id||"")).filter(Boolean));
  const five=ctx.recent_5m,ten=ctx.recent_10m;
  const pressure=five&&five.total>=8&&five.share>=0.78?five:ten&&ten.total>=10&&ten.share>=0.75?ten:null;
  if(!pressure)return [];
  const cards=[];
  for(const m of liveMarkets||[]){
    const marketId=String(m?.market_id||m?.selection_id||"");
    if(!marketId||used.has(marketId)||!liveProviderMarketFresh(m,nowMs,maxAgeMs))continue;
    const type=String(m?.market_type||m?.type||"").toLowerCase(),subject=String(m?.subject||"").toUpperCase(),period=String(m?.period||"GAME").toUpperCase();
    if(type!=="next_goal_team"||pressure.leader!==subject)continue;
    const score=66+Math.min(6,Math.round((pressure.share-.75)*25));
    const market=providerLiveCardMarket(m,type,subject,period);
    cards.push({
      id:`live-provider:${game.game_pk}:${marketId}`,type:"live_provider_next_goal",category:"live",kind:"live",timing:"live",live_origin:"shot_support",
      score,air_score:score,air_label:"LIVE · ДОП.",
      eyebrow:"ДОП. СИГНАЛ · БРОСКИ",value:`${pressure.leader_shots}:${pressure.opponent_shots}`,
      title:`${subject}: ${pressure.leader_shots}:${pressure.opponent_shots} ПО БРОСКАМ ЗА ПОСЛЕДНИЕ ${pressure.minutes} МИНУТ`,broadcast_title:`${subject}: ${pressure.leader_shots}:${pressure.opponent_shots} ПО БРОСКАМ ЗА ПОСЛЕДНИЕ ${pressure.minutes} МИНУТ`,
      broadcast_subtitle:`Только дополнительный аргумент для рынка следующего гола · счёт ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}`,
      explanation:`Броски используются только как краткосрочный дополнительный сигнал для следующего гола. Из этого преимущества больше не выводится победа в матче или тотал.`,
      evidence:{game_pk:game.game_pk,state:game.game_state,period:game.period_number,time_remaining:game.time_remaining,score:`${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}`,shots_by_team:{[pressure.leader]:pressure.leader_shots,[pressure.opponent]:pressure.opponent_shots},shot_share:pressure.share,window_minutes:pressure.minutes||null,feature_layer:"nhl_live_shots_secondary_v3"},
      market,air_reasons:["броски — дополнительный сигнал","только следующий гол","точная live-линия"]
    });
    break;
  }
  return cards;
}
function providerLiveCardMarket(m,type,subject,period){
  const side=String(m?.side||"").toLowerCase(),line=m?.line===null||m?.line===undefined?null:Number(m.line),odds=Number(m?.odds);
  const p=period==="P1"?"1-Й ПЕРИОД · ":period==="P2"?"2-Й ПЕРИОД · ":period==="P3"?"3-Й ПЕРИОД · ":"";
  const label=type==="next_goal_team"?`Следующий гол — ${subject}`:type==="moneyline"?`Победа ${subject}`:`${p}Победа ${subject}`;
  return {type,period,subject,side:side||subject,line:Number.isFinite(line)?line:null,odds,provider:"winline",odds_is_demo:false,odds_source:"provider_live",event_id:m?.event_id||null,market_id:String(m?.market_id||m?.selection_id||""),selection_id:String(m?.selection_id||m?.market_id||""),updated_at:m?.updated_at||null,deeplink:m?.deeplink||null,label};
}
function liveProviderMarketFresh(m,nowMs,maxAgeMs){const t=Date.parse(String(m?.updated_at||""));if(!Number.isFinite(t)||!Number.isFinite(Number(m?.odds))||Number(m.odds)<=1)return false;const age=nowMs-t;return age>=-60000&&age<=maxAgeMs}
function resolveLiveNow(value){if(value instanceof Date)return value.getTime();if(typeof value==="number"&&Number.isFinite(value))return value;if(typeof value==="string"&&Number.isFinite(Date.parse(value)))return Date.parse(value);return Date.now()}

export function buildLiveContext(game,shots){
  const latest=shots.at(-1);
  const windowByMinutes=(minutes)=>{
    if(!latest||!Number.isFinite(latest.elapsed_seconds))return null;
    const cutoff=latest.elapsed_seconds-minutes*60;
    const rows=shots.filter(x=>Number.isFinite(x.elapsed_seconds)&&x.elapsed_seconds>=cutoff);
    const counts=teamCounts(rows,game),[leader,leaderShots]=leaderEntry(counts),other=opponent(game,leader),otherShots=Number(counts[other]||0);
    return {minutes,total:rows.length,leader,leader_shots:leaderShots,opponent:other,opponent_shots:otherShots,share:rows.length?round3(leaderShots/rows.length):0};
  };
  const periods=[1,2,3].map(period=>{
    const rows=shots.filter(x=>Number(x.period_number)===period),goals=rows.filter(x=>x.event_type==="goal"),goalsByTeam=teamCounts(goals,game),shotCounts=teamCounts(rows,game);
    return {period,goals_total:goals.length,goals_by_team:goalsByTeam,shot_events:rows.length,shots_by_team:shotCounts};
  });
  const period=Number(game.period_number||0),periodRows=period?shots.filter(x=>Number(x.period_number)===period):[];
  const periodCounts=teamCounts(periodRows,game),[periodLeader,periodLeaderShots]=leaderEntry(periodCounts),periodOther=opponent(game,periodLeader),periodGoals=periods.find(x=>x.period===period)||{goals_total:0,goals_by_team:{}};
  return {
    recent_5m:windowByMinutes(5),recent_10m:windowByMinutes(10),periods,
    current_period:{period,total:periodRows.length,leader:periodLeader,leader_shots:periodLeaderShots,opponent:periodOther,opponent_shots:Number(periodCounts[periodOther]||0),share:periodRows.length?round3(periodLeaderShots/periodRows.length):0,goals_total:periodGoals.goals_total,goals_by_team:periodGoals.goals_by_team}
  };
}

export function buildLiveCards(game, shots) {
  if (!game?.home_tri || !game?.away_tri || !Array.isArray(shots)) return [];
  const cards = [];
  // V3 policy: shot pressure is never enough for moneyline/totals. Keep at most
  // one very strong short-horizon signal, and only for the next-goal market.
  addRecentMinutesCard(cards, game, shots, 10, 10, 0.75);
  return dedupe(cards).sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,1);
}

function addShotWindowCard(cards, game, shots, windowSize, minLeader, eyebrow, baseScore) {
  if (shots.length < windowSize) return;
  const rows = shots.slice(-windowSize);
  const counts = teamCounts(rows, game);
  const [leader, leaderCount] = leaderEntry(counts);
  const other = opponent(game, leader);
  const otherCount = Number(counts[other] || 0);
  if (leaderCount < minLeader) return;

  cards.push(card({
    game,
    id: `live:${game.game_pk}:sog${windowSize}:${rows.at(-1)?.sort_order || 0}`,
    type: `live_sog_${windowSize}`,
    score: baseScore + Math.min(5, leaderCount - minLeader),
    eyebrow,
    value: `${leaderCount} из ${windowSize}`,
    title: `${leader} нанёс ${leaderCount} из последних ${windowSize} бросков в створ`,
    explanation: `${leaderCount}:${otherCount} по броскам в створ на последнем отрезке. Сигнал давления, а не гарантия следующего гола.`,
    evidence: {
      window_shots: windowSize,
      shots_by_team: counts,
      from_sort_order: rows[0]?.sort_order || null,
      to_sort_order: rows.at(-1)?.sort_order || null,
    },
    market: {
      type: "next_goal_team",
      subject: leader,
      side: leader,
      label: `Следующий гол — ${leader}`,
    },
  }));
}

function addRecentMinutesCard(cards, game, shots, minutes, minShots, minShare) {
  if (shots.length < 2) return;
  const latest = shots.at(-1);
  if (!Number.isFinite(latest?.elapsed_seconds)) return;
  const cutoff = latest.elapsed_seconds - minutes * 60;
  const rows = shots.filter((row) => Number.isFinite(row.elapsed_seconds) && row.elapsed_seconds >= cutoff);
  if (rows.length < minShots) return;
  const counts = teamCounts(rows, game);
  const [leader, leaderCount] = leaderEntry(counts);
  const share = leaderCount / rows.length;
  if (share < minShare) return;
  const other = opponent(game, leader);
  const item=card({
    game,
    id: `live:${game.game_pk}:last${minutes}m:${latest.sort_order || 0}`,
    type: "live_recent_minutes_pressure",
    score: 62 + Math.min(8, Math.floor((share - minShare) * 30)),
    eyebrow: "ДОП. СИГНАЛ · БРОСКИ",
    value: `${leaderCount}:${Number(counts[other] || 0)}`,
    title: `${leader}: ${leaderCount}:${Number(counts[other] || 0)} ПО БРОСКАМ В СТВОР ЗА ПОСЛЕДНИЕ ${minutes} МИНУТ`,
    explanation: `Бросковый перевес используется только как вторичный краткосрочный сигнал на следующий гол. Он не превращается в прогноз победы или тотала.`,
    evidence: {minutes,shots_in_window:rows.length,shots_by_team:counts,share:round3(share),feature_layer:"nhl_live_shots_secondary_v3"},
    market: {type:"next_goal_team",subject:leader,side:leader,label:`Следующий гол — ${leader}`},
  });
  item.live_origin="shot_support";
  item.air_reasons=["броски — дополнительный сигнал","только следующий гол"];
  cards.push(item);
}

function addCurrentPeriodCard(cards, game, shots) {
  const period = Number(game.period_number || 0);
  if (!period) return;
  const rows = shots.filter((row) => Number(row.period_number) === period);
  if (rows.length < 12) return;
  const counts = teamCounts(rows, game);
  const [leader, leaderCount] = leaderEntry(counts);
  const share = leaderCount / rows.length;
  if (share < 0.67) return;
  const other = opponent(game, leader);

  cards.push(card({
    game,
    id: `live:${game.game_pk}:period${period}:${rows.at(-1)?.sort_order || 0}`,
    type: "live_period_shot_control",
    score: 84 + Math.min(6, Math.floor((share - 0.67) * 25)),
    eyebrow: `${period}-Й ПЕРИОД · БРОСКИ`,
    value: `${leaderCount}:${Number(counts[other] || 0)}`,
    title: `${leader} контролирует броски в створ в ${period}-м периоде`,
    explanation: `${leaderCount} из ${rows.length} бросков в створ этого периода принадлежат ${leader}.`,
    evidence: {
      period,
      shots_in_period: rows.length,
      shots_by_team: counts,
      share: round3(share),
    },
    market: {
      type: "next_goal_team",
      period: `P${period}`,
      subject: leader,
      side: leader,
      label: `${period}-й период: следующий гол — ${leader}`,
    },
  }));
}

function addUnansweredRunCard(cards, game, shots) {
  if (!shots.length) return;
  const lastTeam = shots.at(-1)?.team_tri;
  if (!lastTeam) return;
  let run = 0;
  for (let i = shots.length - 1; i >= 0; i -= 1) {
    if (shots[i].team_tri !== lastTeam) break;
    run += 1;
  }
  if (run < 6) return;

  cards.push(card({
    game,
    id: `live:${game.game_pk}:run:${shots.at(-1)?.sort_order || 0}`,
    type: "live_unanswered_shot_run",
    score: 86 + Math.min(8, run - 6),
    eyebrow: "БРОСКИ БЕЗ ОТВЕТА",
    value: `${run} подряд`,
    title: `${lastTeam} нанёс ${run} бросков в створ подряд без ответа соперника`,
    explanation: "Короткий live-импульс. Особенно полезен вместе с реальной ценой рынка следующего гола.",
    evidence: {
      unanswered_shots: run,
      last_sort_order: shots.at(-1)?.sort_order || null,
    },
    market: {
      type: "next_goal_team",
      subject: lastTeam,
      side: lastTeam,
      label: `Следующий гол — ${lastTeam}`,
    },
  }));
}

function addScoreStateCards(cards,game,shots){
  const home=game.home_tri,away=game.away_tri;
  const hs=Number(game.home_score||0),as=Number(game.away_score||0);
  const period=Number(game.period_number||0);
  if(!period||!["LIVE","CRIT"].includes(String(game.game_state||"").toUpperCase()))return;
  const latest=shots.at(-1);
  const cutoff=Number.isFinite(latest?.elapsed_seconds)?latest.elapsed_seconds-10*60:null;
  const recent=cutoff===null?shots.slice(-16):shots.filter(x=>Number.isFinite(x.elapsed_seconds)&&x.elapsed_seconds>=cutoff);
  if(recent.length<10)return;
  const counts=teamCounts(recent,game);
  const [pressureTeam,pressureShots]=leaderEntry(counts);
  const other=opponent(game,pressureTeam),otherShots=Number(counts[other]||0);
  const share=pressureShots/Math.max(1,recent.length);
  if(share<.70)return;
  const pressureScore=pressureTeam===home?hs:as;
  const otherScore=pressureTeam===home?as:hs;
  if(pressureScore<otherScore-1)return;
  const state=pressureScore>otherScore?"leading":pressureScore<otherScore?"trailing":"tied";
  let score=state==="trailing"?86:state==="tied"?89:91;
  score+=Math.min(5,Math.round((share-.70)*25));
  cards.push(card({
    game,
    id:`live:${game.game_pk}:scorestate:${pressureTeam}:${latest?.sort_order||0}`,
    type:"live_moneyline_pressure",
    score:Math.min(96,score),
    eyebrow:state==="trailing"?"ДАВЛЕНИЕ ПРИ -1":state==="leading"?"ДАВЛЕНИЕ ПРИ ЛИДЕРСТВЕ":"ДАВЛЕНИЕ ПРИ РАВНОМ СЧЁТЕ",
    value:`${pressureShots}:${otherShots} по броскам · 10 мин`,
    title:`${pressureTeam}: ${pressureShots}:${otherShots} ПО БРОСКАМ ЗА 10 МИНУТ ПРИ СЧЁТЕ ${away} ${as}:${hs} ${home}`,
    explanation:`За последние ~10 минут ${pressureTeam} нанёс ${pressureShots} бросков в створ, ${other} — ${otherShots}. Текущий счёт ${away} ${as}:${hs} ${home}. Карточка появляется только при сильном преимуществе по броскам и отставании не больше одной шайбы.`,
    evidence:{minutes:10,score_state:state,team:pressureTeam,opponent:other,shots_by_team:counts,shot_share:round3(share),period,feature_layer:"nhl_live_score_state_v2"},
    market:{type:"moneyline",period:"GAME",subject:pressureTeam,side:pressureTeam,label:`Победа ${pressureTeam}`}
  }));
}

function addPeriodTotalPressureCard(cards,game,shots){
  const period=Number(game.period_number||0);
  if(!period||period>3)return;
  const rows=shots.filter(x=>Number(x.period_number)===period);
  if(rows.length<10)return;
  const periodGoals=rows.filter(x=>x.event_type==="goal").length;
  const secondsLeft=Number(game.seconds_remaining);
  const elapsed=Number.isFinite(secondsLeft)?20*60-secondsLeft:null;
  if(elapsed===null||elapsed<5*60)return;
  const shotRate=rows.length/(elapsed/60);
  if(shotRate>=1.15&&secondsLeft>=240){
    cards.push(card({
      game,id:`live:${game.game_pk}:p${period}:total-over:${rows.at(-1)?.sort_order||0}`,
      type:"live_period_total_over",score:86+Math.min(8,Math.round((shotRate-1.15)*8)),
      eyebrow:`${period}-Й ПЕРИОД · ТЕМП`,value:`${rows.length} бросков · ${periodGoals} голов`,
      title:`В ${period}-М ПЕРИОДЕ ВЫСОКИЙ БРОСКОВЫЙ ТЕМП — ${rows.length} БРОСКОВ`,
      explanation:`Темп: ${shotRate.toFixed(2)} броска в створ в минуту периода; осталось ${Math.round(secondsLeft/60)} мин. Используется только с доступной live-линией тотала периода.`,
      evidence:{period,shots_in_period:rows.length,goals_in_period:periodGoals,shot_rate_per_min:round3(shotRate),seconds_remaining:secondsLeft,feature_layer:"nhl_live_period_pace_v1"},
      market:{type:"game_total",period:`P${period}`,subject:null,side:"over",line:periodGoals+0.5,label:`${period}-й период ТБ ${periodGoals+0.5}`}
    }));
  }
  if(shotRate<=.55&&secondsLeft<=480&&periodGoals<=1){
    cards.push(card({
      game,id:`live:${game.game_pk}:p${period}:total-under:${rows.at(-1)?.sort_order||0}`,
      type:"live_period_total_under",score:84+Math.min(8,Math.round((.55-shotRate)*12)),
      eyebrow:`${period}-Й ПЕРИОД · НИЗКИЙ ТЕМП`,value:`${rows.length} бросков · ${periodGoals} голов`,
      title:`В ${period}-М ПЕРИОДЕ НИЗКИЙ БРОСКОВЫЙ ТЕМП — ${rows.length} БРОСКОВ`,
      explanation:`Темп: ${shotRate.toFixed(2)} броска в створ в минуту периода. Используется только при точном совпадении с live-тоталом периода.`,
      evidence:{period,shots_in_period:rows.length,goals_in_period:periodGoals,shot_rate_per_min:round3(shotRate),seconds_remaining:secondsLeft,feature_layer:"nhl_live_period_pace_v1"},
      market:{type:"game_total",period:`P${period}`,subject:null,side:"under",line:periodGoals+1.5,label:`${period}-й период ТМ ${periodGoals+1.5}`}
    }));
  }
}

function card({ game, id, type, score, eyebrow, value, title, explanation, evidence, market }) {
  const pricedMarket=withDemoOdds(market,id);
  return {
    id,
    type,
    category: "live",
    kind: "live",
    timing: "live",
    score: Math.round(score),
    eyebrow,
    value,
    title,
    explanation,
    note: `${pricedMarket.label} · WINLINE · ДЕМО-КЭФ ${pricedMarket.odds.toFixed(2)} · промокод HOH`,
    evidence: {
      ...evidence,
      game_pk: game.game_pk,
      state: game.game_state,
      period: game.period_number,
      time_remaining: game.time_remaining,
      score: `${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}`,
    },
    market: pricedMarket,
  };
}

function teamCounts(rows, game) {
  const counts = {
    [game.away_tri]: 0,
    [game.home_tri]: 0,
  };
  for (const row of rows) {
    if (row.team_tri in counts) counts[row.team_tri] += 1;
  }
  return counts;
}

function leaderEntry(counts) {
  return Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || ["", 0];
}

function opponent(game, team) {
  return team === game.home_tri ? game.away_tri : game.home_tri;
}

function gameElapsedSeconds(play) {
  const period = Number(play.periodDescriptor?.number || 0);
  const periodType = String(play.periodDescriptor?.periodType || "REG");
  const inPeriod = parseClock(play.timeInPeriod);
  if (!period || inPeriod === null) return null;
  if (periodType === "SO") return null;
  const regulationBefore = Math.min(Math.max(period - 1, 0), 3) * 20 * 60;
  if (period <= 3) return regulationBefore + inPeriod;
  const overtimeBefore = 3 * 20 * 60 + Math.max(period - 4, 0) * 20 * 60;
  return overtimeBefore + inPeriod;
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function dedupe(cards) {
  const seen = new Set();
  return cards.filter((item) => {
    const key = `${item.type}:${item.market?.type || ""}:${item.market?.subject || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
