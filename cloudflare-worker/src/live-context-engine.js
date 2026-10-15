import { applyWinlineMarkets } from "./winline-market-adapter.js";
import { loadBroadcastPregameArchive } from "./broadcast-insight-history.js";
import { regulationBasisRows } from "./regulation-basis.js";
import { loadSpecialTeams } from "./nhl-special-teams.js";

const MIN_SAMPLE=8;
const MIN_ODDS=1.50;
const RECENT_GAMES=12;
// score-state stories («уступая шайбу после двух периодов…») need a longer memory: about the season and the last one
const LONG_GAMES=90;
const MIN_SITUATION_SAMPLE=5;
// teams score in regulation in ~95% of games (2025/26), so only a long run is a story for «обе забьют»
const BTTS_MIN_STREAK=20;

export async function buildLiveHistoricalContext(db,snapshot,providerMarkets,options={}){
  const game=snapshot?.game||{};
  if(!db||!Number.isSafeInteger(Number(game.game_pk))||!game.away_tri||!game.home_tri)return [];
  let featureResults=[{results:[]},{results:[]}];
  try{
    featureResults=await db.batch([
      recentFeatures(db,game.away_tri,game.game_pk),
      recentFeatures(db,game.home_tri,game.game_pk),
    ]);
  }catch(error){
    console.error("live historical feature read failed",error);
  }
  let archive={cards:[]};
  try{archive=await loadBroadcastPregameArchive(db,Number(game.game_pk));}
  catch(error){console.error("live pregame archive read failed",error)}
  const awayRows=featureResults?.[0]?.results||[],homeRows=featureResults?.[1]?.results||[];
  const rowsByTeam=new Map([
    [String(game.away_tri).toUpperCase(),awayRows.slice(0,RECENT_GAMES)],
    [String(game.home_tri).toUpperCase(),homeRows.slice(0,RECENT_GAMES)],
  ]);
  const longRows=new Map([[String(game.away_tri).toUpperCase(),awayRows],[String(game.home_tri).toUpperCase(),homeRows]]);
  let special=null;
  if(snapshot?.live_context?.power_play){
    try{special=await loadSpecialTeams(db,{seasonId:game.season_id,fetchImpl:options.fetchImpl||fetch})}
    catch(error){console.error("live special teams read failed",error)}
  }
  const history=buildProviderHistoryCards(snapshot,providerMarkets,rowsByTeam,options);
  const situation=buildSituationCards(snapshot,providerMarkets,{recent:rowsByTeam,long:longRows,special},options);
  const repriced=repricePregameLiveCards(snapshot,archive?.cards||[],providerMarkets,options);
  return mergeLiveInsightCards([...history,...situation],repriced);
}

function recentFeatures(db,team,gamePk){
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,is_home,final_win,final_goals_for,final_goals_against,
           final_goal_diff,total_goals,regulation_goals_for,regulation_goals_against,p1_goals_for,p1_goals_against,
           p2_goals_for,p2_goals_against,p3_goals_for,p3_goals_against
    FROM team_game_features
    WHERE team_tri=? AND game_pk<>?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT ${LONG_GAMES};
  `).bind(team,gamePk);
}

// Cards that read the situation on the ice, so the 2nd and 3rd periods are not left with shots only (commentators,
// 2026-10-05 and 2026-10-11: «ко второму периоду кэфы иссякают»):
//   score_state_history — what this team did with the same score after the same number of periods;
//   btts_history        — the team that has not scored yet usually does (market «обе забьют»);
//   power_play          — a power play on the ice right now and the team's season percentage (market «следующий гол»).
export function buildSituationCards(snapshot,providerMarkets,data={},options={}){
  const nowMs=resolveNow(options.now),maxAgeMs=finitePositive(options.market_max_age_ms,90_000);
  const markets=(providerMarkets||[]).filter(m=>freshLiveMarket(m,nowMs,maxAgeMs));
  const recent=rowsMap(data.recent),long=rowsMap(data.long);
  const cards=[...scoreStateCards(snapshot,markets,long.size?long:recent)];
  for(const m of markets){
    const type=String(m?.market_type||m?.type||"").toLowerCase(),period=String(m?.period||"GAME").toUpperCase();
    let card=null;
    if(type==="both_teams_score"&&period==="GAME"&&String(m?.side||"").toLowerCase()==="yes")card=bothScoreCard(snapshot,m,recent,long);
    else if(type==="next_goal_team"&&data.special)card=powerPlayCard(snapshot,m,data.special);
    if(card)cards.push(card);
  }
  return dedupeByProviderSelection(cards).sort((a,b)=>Number(b.air_score||0)-Number(a.air_score||0));
}

const SITUATION_RULES={
  // The share of such games the story needs: 1.3–2× the league in that situation. League 2025/26 (team_game_features):
  // after P1 −1 win 33% / no regulation loss 44%, −2 21% / 32%; after P2 −1 24% / 40%, −2 8% / 14%; tied 50%;
  // after P1 +1 win 67%, +2 79%; after P2 +1 76%.
  trail:{1:{"-1":{dc:0.58,ml:0.45},"-2":{dc:0.50,ml:0.36}},2:{"-1":{dc:0.52,ml:0.34},"-2":{dc:0.25,ml:0.17}}},
  tie:0.62,
  lead:{1:{"1":0.80,"2":0.90},2:{"1":0.90}},
};

function scoreStateCards(snapshot,markets,longMap){
  const game=snapshot?.game||{},st=completedPeriodState(snapshot);if(!st)return [];
  const out=[];
  for(const team of [String(game.away_tri||"").toUpperCase(),String(game.home_tri||"").toUpperCase()]){
    const opp=opponent(game,team),own=team===String(game.away_tri).toUpperCase()?st.away:st.home,other=team===String(game.away_tri).toUpperCase()?st.home:st.away,d=own-other;
    if(Math.abs(d)>2)continue;
    const rows=periodCheckedRows(rowsFor(longMap,team)).filter(r=>diffAfter(r,st.k)===d);
    if(rows.length<MIN_SITUATION_SAMPLE)continue;
    const wins=boolRate(rows,r=>Number(r.final_win)===1);
    const noLoss=boolRate(rows,r=>Number(r.regulation_goals_for)>=Number(r.regulation_goals_against));
    const options=[];
    if(d<0){
      const rule=SITUATION_RULES.trail[st.k]?.[String(d)];
      if(rule){options.push({stat:noLoss,need:rule.dc,market:findMarket(markets,"double_chance","REG",team,"team_or_draw"),kind:"no_loss"});options.push({stat:wins,need:rule.ml,market:findMarket(markets,"moneyline","GAME",team,team),kind:"win"});}
    }else if(d===0){
      if(rows.length>=6)options.push({stat:wins,need:SITUATION_RULES.tie,market:findMarket(markets,"moneyline","GAME",team,team),kind:"win"});
    }else{
      const need=SITUATION_RULES.lead[st.k]?.[String(d)];
      if(need&&rows.length>=6)options.push({stat:wins,need,market:findMarket(markets,"moneyline","GAME",team,team),kind:"win"});
    }
    let best=null;
    for(const o of options){
      if(!o.market||o.stat.hits<3||o.stat.rate<o.need)continue;
      const score=clamp(74+Math.round((o.stat.rate-o.need)*60)+(snapshot.game?.in_intermission?3:0),64,92);
      if(!best||score>best.score)best={...o,score};
    }
    if(!best)continue;
    const after=st.k===1?"ПОСЛЕ 1-ГО ПЕРИОДА":"ПОСЛЕ ДВУХ ПЕРИОДОВ";
    const state=d===-1?"УСТУПАЯ ШАЙБУ":d===-2?"УСТУПАЯ ДВЕ ШАЙБЫ":d===1?"ВЕДЯ В ОДНУ ШАЙБУ":d===2?"ВЕДЯ В ДВЕ ШАЙБЫ":"ПРИ НИЧЬЕЙ";
    const {hits,sample}=best.stat;
    const title=best.kind==="no_loss"
      ?`${state} ${after}, ${team} НЕ ПРОИГРАЛ В ОСНОВНОЕ ВРЕМЯ В ${hits} ИЗ ${sample} МАТЧЕЙ`
      :d===0?`ПРИ НИЧЬЕЙ ${after} ${team} ВЫИГРАЛ В ${hits} ИЗ ${sample} МАТЧЕЙ`:`${state} ${after}, ${team} ВЫИГРАЛ В ${hits} ИЗ ${sample} МАТЧЕЙ`;
    const since=sinceText(rows);
    out.push(providerCard(snapshot,best.market,{
      origin:"score_state_history",score:best.score,eyebrow:`LIVE · СЧЁТ ${after}`,value:`${hits}/${sample}`,title,
      subtitle:`Сейчас ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri} · ${sample} таких матчей ${team}${since?` с ${since}`:""}`,
      explanation:`Все матчи ${team}${since?` с ${since}`:""}, где после ${st.k}-го периода был такой же счёт по разнице шайб. Счёт по периодам сверен с итогом основного времени.`,
      evidence:{team,opponent:opp,situation:{after_period:st.k,score_diff:d},hits,decisions:sample,sample,hit_rate:best.stat.rate,game_pks:rows.map(r=>Number(r.game_pk)),stats_validation:"period_sums_match_regulation",feature_layer:"live_score_state_history_v1"},
      reasons:["тот же счёт после того же периода","история команды","точная live-линия"],
    }));
  }
  return out;
}

// The score after the last finished period, while it is still the score on the ice: in the intermission, or in the
// first half of the next period with no goal yet.
function completedPeriodState(snapshot){
  const game=snapshot?.game||{},period=Number(game.period_number||0),state=String(game.game_state||"").toUpperCase();
  if(!["LIVE","CRIT"].includes(state))return null;
  const k=game.in_intermission?period:period-1;
  if(k<1||k>2)return null;
  if(!game.in_intermission){const sec=Number(game.seconds_remaining);if(!Number.isFinite(sec)||sec<10*60)return null}
  let away=0,home=0;
  for(const row of snapshot?.live_context?.periods||[]){
    if(Number(row.period)>k)continue;
    away+=Number(row.goals_by_team?.[game.away_tri]||0);home+=Number(row.goals_by_team?.[game.home_tri]||0);
  }
  if(away!==Number(game.away_score||0)||home!==Number(game.home_score||0))return null;
  return {k,away,home};
}

function bothScoreCard(snapshot,m,recentMap,longMap){
  const game=snapshot?.game||{},as=Number(game.away_score||0),hs=Number(game.home_score||0);
  const scoreless=[as===0?game.away_tri:null,hs===0?game.home_tri:null].filter(Boolean);
  if(scoreless.length!==1)return null;
  const team=String(scoreless[0]).toUpperCase(),opp=opponent(game,team),period=Number(game.period_number||0),sec=Number(game.seconds_remaining);
  if(period>3||(period===3&&Number.isFinite(sec)&&sec<240))return null;
  const scored=boolRate(rowsFor(recentMap,team).slice(0,10),r=>regulationGoals(r,"for")>0);
  const conceded=boolRate(rowsFor(recentMap,opp).slice(0,10),r=>regulationGoals(r,"against")>0);
  if(scored.sample<MIN_SAMPLE||conceded.sample<MIN_SAMPLE||conceded.rate<0.8)return null;
  const history=rowsFor(longMap,team).length?rowsFor(longMap,team):rowsFor(recentMap,team);
  let streak=0;for(const r of history){if(regulationGoals(r,"for")>0)streak++;else break}
  if(streak<BTTS_MIN_STREAK)return null;
  // the whole stored history without a blank game: say since when, not «подряд» (the run may be longer)
  const matches=`${streak} ${streak%10===1&&streak%100!==11?"МАТЧЕ":"МАТЧАХ"}`,since=sinceText(history);
  const title=streak===history.length&&since?`${team} ЗАБИВАЛ ВО ВСЕХ ${matches} С ${since.toUpperCase()}`:`${team} ЗАБИВАЕТ В ${matches} ПОДРЯД`;
  const score=clamp(72+Math.min(10,Math.floor((streak-BTTS_MIN_STREAK)/5))+Math.round((conceded.rate-0.8)*20)+(period===3?4:0),64,88);
  return providerCard(snapshot,m,{
    origin:"btts_history",score,eyebrow:"LIVE · ОБЕ ЗАБЬЮТ",value:`${streak} подряд`,title,
    subtitle:`Сейчас ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri} · ${opp} пропускал в ${conceded.hits} из ${conceded.sample} последних матчей`,
    explanation:`${team} ещё не забил в этом матче. Голы основного времени: ${team} забивает ${streak} матчей подряд, ${opp} пропускал в ${conceded.hits} из ${conceded.sample} последних.`,
    evidence:{team,opponent:opp,team_scored:scored,opponent_conceded:conceded,scoring_streak:streak,hits:scored.hits,decisions:scored.sample,hit_rate:scored.rate,feature_layer:"live_btts_history_v1"},
    reasons:["команда без гола в матче","забивает почти всегда","точная live-линия"],
  });
}

function powerPlayCard(snapshot,m,special){
  const pp=snapshot?.live_context?.power_play,game=snapshot?.game||{};if(!pp)return null;
  const team=String(m?.subject||"").toUpperCase();if(team!==String(pp.team).toUpperCase())return null;
  const own=special?.[team],opp=special?.[String(pp.opponent).toUpperCase()];
  if(!own||Number(own.gp)<3)return null;
  const weakKill=opp&&Number(opp.pk)<=0.78;
  if(Number(own.pp)<0.20&&!weakKill)return null;
  const ppPct=Math.round(Number(own.pp)*100),pkPct=opp?Math.round(Number(opp.pk)*100):null;
  const title=Number(own.pp_rank)<=10?`${team} В БОЛЬШИНСТВЕ: ${ppPct}% РЕАЛИЗАЦИИ — ${own.pp_rank}-Е МЕСТО В НХЛ`:`${team} В БОЛЬШИНСТВЕ: ${ppPct}% РЕАЛИЗАЦИИ В СЕЗОНЕ`;
  const score=clamp(84+Math.min(8,Math.round((Number(own.pp)-0.2)*40))+(weakKill?3:0),80,95);
  return providerCard(snapshot,m,{
    origin:"power_play",score,eyebrow:`LIVE · БОЛЬШИНСТВО ${String(pp.skaters||"").replace("x"," НА ")}`,value:`${ppPct}%`,title,
    subtitle:`${pp.opponent}${pkPct!==null?` в меньшинстве: ${pkPct}%${opp.pk_rank?` (${opp.pk_rank}-е место)`:""}`:""} · сейчас ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}`,
    explanation:`Идёт большинство ${team} (${pp.skaters}). Реализация большинства и меньшинства — статистика НХЛ за сезон (${own.gp} матчей у ${team}).`,
    evidence:{team,opponent:pp.opponent,power_play:pp,team_power_play:own,opponent_penalty_kill:opp||null,feature_layer:"live_power_play_v1"},
    reasons:["большинство прямо сейчас","реализация за сезон","точная live-линия"],
  });
}

function findMarket(markets,type,period,subject,side){
  return (markets||[]).find(m=>String(m?.market_type||m?.type||"").toLowerCase()===type&&String(m?.period||"GAME").toUpperCase()===period&&String(m?.subject||"").toUpperCase()===subject&&String(m?.side||"").toLowerCase()===String(side).toLowerCase())||null;
}
function periodCheckedRows(rows){
  return (rows||[]).filter(r=>{
    const p=[1,2,3].map(n=>[Number(r?.[`p${n}_goals_for`]),Number(r?.[`p${n}_goals_against`])]);
    if(p.some(([f,a])=>!Number.isInteger(f)||!Number.isInteger(a)||f<0||a<0))return false;
    const gf=Number(r?.regulation_goals_for),ga=Number(r?.regulation_goals_against);
    if(!Number.isInteger(gf)||!Number.isInteger(ga))return false;
    return p.reduce((s,x)=>s+x[0],0)===gf&&p.reduce((s,x)=>s+x[1],0)===ga&&[0,1].includes(Number(r?.final_win))&&r?.final_win!==null&&r?.final_win!==undefined&&r?.final_win!=="";
  });
}
function diffAfter(r,k){let d=0;for(let n=1;n<=k;n++)d+=Number(r[`p${n}_goals_for`])-Number(r[`p${n}_goals_against`]);return d}
function regulationGoals(r,side){const reg=r?.[`regulation_goals_${side}`];return Number(reg!==null&&reg!==undefined&&reg!==""?reg:r?.[`final_goals_${side}`])}
const MONTHS_GEN=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
function sinceText(rows){
  const t=Math.min(...(rows||[]).map(r=>Date.parse(String(r?.scheduled_start_utc||""))).filter(Number.isFinite));
  if(!Number.isFinite(t))return "";
  const d=new Date(t);return `${MONTHS_GEN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function rowsMap(input){
  if(input instanceof Map)return new Map([...input.entries()].map(([k,v])=>[String(k).toUpperCase(),v||[]]));
  return new Map(Object.entries(input||{}).map(([k,v])=>[String(k).toUpperCase(),v||[]]));
}

export function buildProviderHistoryCards(snapshot,providerMarkets,rowsByTeamInput,options={}){
  const game=snapshot?.game||{},nowMs=resolveNow(options.now),maxAgeMs=finitePositive(options.market_max_age_ms,90_000);
  const rowsByTeam=new Map([...(rowsByTeamInput instanceof Map?rowsByTeamInput:new Map(Object.entries(rowsByTeamInput||{}))).entries()].map(([team,rows])=>[team,regulationBasisRows(rows)]));
  const cards=[];
  for(const raw of providerMarkets||[]){
    if(!freshLiveMarket(raw,nowMs,maxAgeMs))continue;
    const type=String(raw?.market_type||raw?.type||"").toLowerCase();
    const period=String(raw?.period||"GAME").toUpperCase();
    let card=null;
    if(/^period_[123]_result$/.test(type))card=periodResultCard(snapshot,raw,rowsByTeam);
    else if(type==="game_total"&&/^P[123]$/.test(period))card=periodTotalCard(snapshot,raw,rowsByTeam);
    else if(type==="game_total"&&period==="GAME")card=gameTotalCard(snapshot,raw,rowsByTeam);
    else if(type==="team_total"&&period==="GAME")card=teamTotalCard(snapshot,raw,rowsByTeam);
    else if(type==="moneyline"&&period==="GAME")card=moneylineCard(snapshot,raw,rowsByTeam);
    if(card)cards.push(card);
  }
  return dedupeByProviderSelection(cards).sort((a,b)=>Number(b.air_score||0)-Number(a.air_score||0));
}

export function repricePregameLiveCards(snapshot,pregameCards,providerMarkets,options={}){
  const game=snapshot?.game||{},nowMs=resolveNow(options.now),maxAgeMs=finitePositive(options.market_max_age_ms,90_000);
  const liveMarkets=(providerMarkets||[]).filter(m=>freshLiveMarket(m,nowMs,maxAgeMs));
  const eligible=(pregameCards||[]).filter(card=>pregameCardStillRelevant(snapshot,card));
  let priced=[];
  try{priced=applyWinlineMarkets(eligible,liveMarkets,{now:nowMs,max_age_ms:maxAgeMs});}
  catch(error){console.error("live pregame reprice failed",error);return []}
  return priced.map(card=>{
    const market=card.market||{},period=String(market.period||"GAME").toUpperCase();
    let score=Math.max(58,Math.min(86,Number(card.air_score??card.score??68)));
    if(period===`P${Number(game.period_number||0)}`)score+=6;
    else if(/^P[123]$/.test(period))score+=2;
    if(String(market.type||"").toLowerCase()==="moneyline")score+=2;
    score=Math.min(92,Math.round(score));
    return {
      ...card,
      id:`live-pregame:${game.game_pk}:${card.id||card.archive?.snapshot_key||market.market_id||"signal"}`,
      category:"live_context",kind:"live",timing:"live",live_origin:"pregame_repriced",
      score,air_score:score,air_label:"LIVE",
      broadcast_title:card.broadcast_title||card.title||"ПРЕДМАТЧЕВЫЙ СИГНАЛ",
      broadcast_subtitle:`Предматчевый сигнал сохранился в текущей линии · ${liveStateText(snapshot)}`,
      explanation:`Этот статистический аргумент был сформирован до матча и сейчас заново сопоставлен с актуальной live-линией Winline. Он не основан на количестве бросков в текущем отрезке.`,
      evidence:{...(card.evidence||{}),feature_layer:"live_pregame_reprice_v1",live_state:liveStateEvidence(snapshot)},
      air_reasons:["предматчевый сигнал","актуальная live-линия"],
    };
  });
}

export function mergeLiveInsightCards(contextCards=[],shotCards=[]){
  const all=[...(contextCards||[]),...(shotCards||[])].filter(hasRealPrice)
    .sort((a,b)=>Number(b.air_score??b.score??0)-Number(a.air_score??a.score??0));
  const unique=dedupeByProviderSelection(all);
  const out=[],originCounts=new Map();
  for(const card of unique){
    const origin=String(card.live_origin||"live_other");
    const used=Number(originCounts.get(origin)||0);
    const cap=origin==="shot_support"||origin==="power_play"||origin==="btts_history"?1:origin==="score_state_history"?2:origin==="pregame_repriced"?4:origin.startsWith("period_")?4:3;
    if(used>=cap)continue;
    out.push(card);originCounts.set(origin,used+1);
    if(out.length>=12)break;
  }
  return out;
}

export function summarizeLiveCardMix(cards=[]){
  const origins={};
  for(const c of cards||[]){const k=String(c?.live_origin||"other");origins[k]=Number(origins[k]||0)+1}
  return {total:(cards||[]).length,origins,shot_based:Number(origins.shot_support||0),non_shot:(cards||[]).length-Number(origins.shot_support||0)};
}

function periodResultCard(snapshot,m,rowsByTeam){
  const game=snapshot.game||{},type=String(m.market_type||m.type||"").toLowerCase();
  const mm=/^period_([123])_result$/.exec(type);if(!mm)return null;
  const p=Number(mm[1]),current=Number(game.period_number||0);
  if(current&&p<current)return null;
  if(current&&p>current+1)return null;
  const team=String(m.subject||"").toUpperCase();if(![game.away_tri,game.home_tri].includes(team))return null;
  const opp=opponent(game,team),rows=rowsFor(rowsByTeam,team),oppRows=rowsFor(rowsByTeam,opp);
  const own=resultRate(rows,p,"win"),oppLoss=resultRate(oppRows,p,"loss");
  if(own.sample<MIN_SAMPLE||own.rate<0.60)return null;
  if(oppLoss.sample>=MIN_SAMPLE&&oppLoss.rate<0.40)return null;
  const live=periodScore(snapshot,p,team,opp),sec=Number(game.seconds_remaining);
  if(current===p&&live.diff<=-2)return null;
  if(current===p&&live.diff===-1&&Number.isFinite(sec)&&sec<=300)return null;
  const supportRate=oppLoss.sample>=MIN_SAMPLE?oppLoss.rate:0.50;
  const strength=0.72*own.rate+0.28*supportRate;
  let score=70+Math.round((strength-0.55)*55);
  if(current===p)score+=live.diff>0?7:live.diff===0?4:-4;
  else score-=3;
  const subtitleParts=[`${opp}: проиграл этот период ${oppLoss.hits}/${oppLoss.sample||0}`,current===p?`сейчас в периоде ${live.team}:${live.opp}`:`следующий ${p}-й период`];
  return providerCard(snapshot,m,{
    origin:"period_result_history",score:clamp(score,62,94),eyebrow:`${p}-Й ПЕРИОД · ИСТОРИЯ`,
    value:`${own.hits}/${own.sample}`,
    title:`${team} ВЫИГРАЛ ${p}-Й ПЕРИОД В ${own.hits} ИЗ ${own.sample} ПОСЛЕДНИХ МАТЧЕЙ`,
    subtitle:subtitleParts.join(" · "),
    explanation:`История именно ${p}-го периода: ${team} ${own.hits}/${own.sample}; ${opp} проиграл этот период ${oppLoss.hits}/${oppLoss.sample}. Текущий счёт используется как отдельный live-контекст, а не выводится из бросков.`,
    evidence:{period:p,team_period_wins:own,opponent_period_losses:oppLoss,current_period_score:live,feature_layer:"live_period_result_history_v1"},
    reasons:["история конкретного периода","текущий счёт","точная live-линия"],
  });
}

function periodTotalCard(snapshot,m,rowsByTeam){
  const game=snapshot.game||{},period=String(m.period||"").toUpperCase(),p=Number(period.slice(1));
  const current=Number(game.period_number||0);if(!p||p>3||(current&&p<current)||(current&&p>current+1))return null;
  const side=String(m.side||"").toLowerCase(),line=Number(m.line);if(!["over","under"].includes(side)||!Number.isFinite(line))return null;
  const away=rateByValue(rowsFor(rowsByTeam,game.away_tri),r=>periodTotal(r,p),side,line);
  const home=rateByValue(rowsFor(rowsByTeam,game.home_tri),r=>periodTotal(r,p),side,line);
  if(away.sample<MIN_SAMPLE||home.sample<MIN_SAMPLE)return null;
  const combinedHits=away.hits+home.hits,combinedSample=away.sample+home.sample,rate=combinedHits/combinedSample;
  if(Math.min(away.rate,home.rate)<0.50||rate<0.62)return null;
  const live=periodScore(snapshot,p,game.away_tri,game.home_tri),goals=live.total,sec=Number(game.seconds_remaining);
  if(current===p&&side==="under"&&goals>line)return null;
  if(current===p&&side==="over"&&goals>line)return null;
  let score=76+Math.round((rate-0.60)*55);
  if(current===p){score+=5;if(side==="under"&&Number.isFinite(sec)&&sec<=480)score+=3;if(side==="over"&&Number.isFinite(sec)&&sec<=180&&goals<line)score-=8;}
  else score-=2;
  const dir=side==="over"?"ТБ":"ТМ";
  return providerCard(snapshot,m,{
    origin:"period_total_history",score:clamp(score,62,94),eyebrow:`${p}-Й ПЕРИОД · ТОТАЛ`,
    value:`${combinedHits}/${combinedSample}`,
    title:`${dir} ${fmtLine(line)} В ${p}-М ПЕРИОДЕ — ${combinedHits} ИЗ ${combinedSample} ПОСЛЕДНИХ МАТЧЕЙ ЭТИХ КОМАНД`,
    subtitle:`${game.away_tri}: ${away.hits}/${away.sample} · ${game.home_tri}: ${home.hits}/${home.sample}${current===p?` · сейчас голов в периоде: ${goals}`:""}`,
    explanation:`Для обеих команд отдельно посчитана частота точной линии ${dir} ${fmtLine(line)} именно в ${p}-м периоде. Карточка требует согласия двух исторических срезов и актуальной live-линии.`,
    evidence:{period:p,line,side,away,home,current_period_goals:goals,feature_layer:"live_period_total_history_v1"},
    reasons:["статистика периода","два независимых среза","точная live-линия"],
  });
}

function gameTotalCard(snapshot,m,rowsByTeam){
  const game=snapshot.game||{},side=String(m.side||"").toLowerCase(),line=Number(m.line);if(!["over","under"].includes(side)||!Number.isFinite(line))return null;
  const away=rateByValue(rowsFor(rowsByTeam,game.away_tri),r=>Number(r.total_goals),side,line);
  const home=rateByValue(rowsFor(rowsByTeam,game.home_tri),r=>Number(r.total_goals),side,line);
  if(away.sample<MIN_SAMPLE||home.sample<MIN_SAMPLE)return null;
  const hits=away.hits+home.hits,sample=away.sample+home.sample,rate=hits/sample;
  if(Math.min(away.rate,home.rate)<0.50||rate<0.64)return null;
  const currentTotal=Number(game.away_score||0)+Number(game.home_score||0);
  if(side==="under"&&currentTotal>line)return null;
  if(side==="over"&&currentTotal>line)return null;
  let score=73+Math.round((rate-0.60)*50);
  const period=Number(game.period_number||0),sec=Number(game.seconds_remaining);
  if(period===3&&Number.isFinite(sec)&&sec<=300&&side==="over"&&line-currentTotal>=2)score-=10;
  const dir=side==="over"?"ТБ":"ТМ";
  return providerCard(snapshot,m,{
    origin:"game_total_history",score:clamp(score,60,91),eyebrow:"LIVE · ТОТАЛ МАТЧА",value:`${hits}/${sample}`,
    title:`${dir} ${fmtLine(line)} — ${hits} ИЗ ${sample} ПОСЛЕДНИХ МАТЧЕЙ ЭТИХ КОМАНД`,
    subtitle:`Сейчас ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri} · ${game.period_number||"—"}-й период`,
    explanation:`Точная текущая линия проверена на последних матчах обеих команд. Текущий счёт и оставшееся время используются для live-фильтра.`,
    evidence:{line,side,away,home,current_total:currentTotal,feature_layer:"live_game_total_history_v1"},
    reasons:["форма обеих команд","текущий счёт","точная live-линия"],
  });
}

function teamTotalCard(snapshot,m,rowsByTeam){
  const game=snapshot.game||{},team=String(m.subject||"").toUpperCase();if(![game.away_tri,game.home_tri].includes(team))return null;
  const opp=opponent(game,team),side=String(m.side||"").toLowerCase(),line=Number(m.line);if(!["over","under"].includes(side)||!Number.isFinite(line))return null;
  const own=rateByValue(rowsFor(rowsByTeam,team),r=>Number(r.final_goals_for),side,line);
  const allowed=rateByValue(rowsFor(rowsByTeam,opp),r=>Number(r.final_goals_against),side,line);
  if(own.sample<MIN_SAMPLE||allowed.sample<MIN_SAMPLE)return null;
  const hits=own.hits+allowed.hits,sample=own.sample+allowed.sample,rate=hits/sample;
  if(Math.min(own.rate,allowed.rate)<0.50||rate<0.63)return null;
  const currentGoals=team===game.away_tri?Number(game.away_score||0):Number(game.home_score||0);
  if(side==="under"&&currentGoals>line)return null;
  if(side==="over"&&currentGoals>line)return null;
  let score=78+Math.round((rate-0.60)*48);
  const period=Number(game.period_number||0),sec=Number(game.seconds_remaining);
  if(period===3&&Number.isFinite(sec)&&sec<=300&&side==="over"&&line-currentGoals>=1.5)score-=9;
  const dir=side==="over"?"ТБ":"ТМ";
  return providerCard(snapshot,m,{
    origin:"team_total_history",score:clamp(score,62,93),eyebrow:"LIVE · КОМАНДНЫЙ ТОТАЛ",value:`${hits}/${sample}`,
    title:`${team} ${dir} ${fmtLine(line)}: ${own.hits}/${own.sample} У СЕБЯ, ${allowed.hits}/${allowed.sample} ПО ПРОПУЩЕННЫМ У ${opp}`,
    subtitle:`Сейчас у ${team} ${currentGoals} шайб · ${liveStateText(snapshot)}`,
    explanation:`Совмещены два независимых предматчевых среза: сколько забивает ${team} и сколько пропускает ${opp} на этой точной линии.`,
    evidence:{team,opponent:opp,line,side,team_scoring:own,opponent_allowing:allowed,current_team_goals:currentGoals,feature_layer:"live_team_total_history_v1"},
    reasons:["атака команды","защита соперника","точная live-линия"],
  });
}

function moneylineCard(snapshot,m,rowsByTeam){
  const game=snapshot.game||{},team=String(m.subject||"").toUpperCase();if(![game.away_tri,game.home_tri].includes(team))return null;
  const opp=opponent(game,team),rows=rowsFor(rowsByTeam,team).slice(0,10),oppRows=rowsFor(rowsByTeam,opp).slice(0,10);
  const own=boolRate(rows,r=>Number(r.final_win)===1),oppLoss=boolRate(oppRows,r=>Number(r.final_win)===0);
  if(own.sample<MIN_SAMPLE||oppLoss.sample<MIN_SAMPLE||own.rate<0.60)return null;
  const isHome=team===game.home_tri?1:0,venueRows=rowsFor(rowsByTeam,team).filter(r=>Number(r.is_home)===isHome).slice(0,8),venue=boolRate(venueRows,r=>Number(r.final_win)===1);
  const strength=venue.sample>=5?(own.rate*0.5+oppLoss.rate*0.3+venue.rate*0.2):(own.rate*0.65+oppLoss.rate*0.35);
  if(strength<0.60)return null;
  const teamScore=team===game.away_tri?Number(game.away_score||0):Number(game.home_score||0),oppScore=team===game.away_tri?Number(game.home_score||0):Number(game.away_score||0),diff=teamScore-oppScore;
  const period=Number(game.period_number||0),sec=Number(game.seconds_remaining);
  if(diff<=-2)return null;
  if(period===3&&diff<0&&Number.isFinite(sec)&&sec<=600)return null;
  let score=70+Math.round((strength-0.55)*55)+(diff>0?6:diff===0?3:-5);
  return providerCard(snapshot,m,{
    origin:"moneyline_history",score:clamp(score,60,90),eyebrow:"LIVE · ФОРМА + СЧЁТ",value:`${own.hits}/${own.sample}`,
    title:`${team}: ${own.hits} ПОБЕД В ${own.sample} ПОСЛЕДНИХ; ${opp} ПРОИГРАЛ ${oppLoss.hits} ИЗ ${oppLoss.sample}`,
    subtitle:`Сейчас ${game.away_tri} ${game.away_score}:${game.home_score} ${game.home_tri}${venue.sample>=5?` · на текущей площадке ${venue.hits}/${venue.sample}`:""}`,
    explanation:`Победа в live предлагается только когда предматчевая форма команды и слабая форма соперника совпадают, а текущий счёт не противоречит сигналу. Броски в этот расчёт не входят.`,
    evidence:{team,opponent:opp,team_wins:own,opponent_losses:oppLoss,venue,current_score_diff:diff,feature_layer:"live_moneyline_history_v1"},
    reasons:["предматчевая форма","форма соперника","текущий счёт"],
  });
}

function providerCard(snapshot,m,{origin,score,eyebrow,value,title,subtitle,explanation,evidence,reasons}){
  const game=snapshot.game||{},type=String(m.market_type||m.type||"").toLowerCase(),period=String(m.period||"GAME").toUpperCase(),subject=m.subject||null,side=String(m.side||"").toLowerCase(),line=finiteOrNull(m.line),odds=Number(m.odds);
  return {
    id:`live-history:${game.game_pk}:${String(m.market_id||m.selection_id||type)}:${origin}`,
    type:`live_${origin}`,category:"live_context",kind:"live",timing:"live",live_origin:origin,
    score:Math.round(score),air_score:Math.round(score),air_label:"LIVE",eyebrow,value,title,broadcast_title:title,broadcast_subtitle:subtitle,explanation,
    evidence:{...evidence,game_pk:Number(game.game_pk),live_state:liveStateEvidence(snapshot)},
    market:{type,period,subject,side,line,odds,provider:"winline",odds_is_demo:false,odds_source:"provider_live",event_id:m.event_id||null,market_id:String(m.market_id||m.selection_id||""),selection_id:String(m.selection_id||m.market_id||""),updated_at:m.updated_at||null,deeplink:m.deeplink||null,label:marketLabel(type,period,subject,side,line)},
    air_reasons:reasons||[],
  };
}

function pregameCardStillRelevant(snapshot,card){
  const game=snapshot?.game||{},m=card?.market||{},type=String(m.type||"").toLowerCase(),period=String(m.period||"GAME").toUpperCase(),current=Number(game.period_number||0);
  if(type.startsWith("player_")||type==="next_goal_team"||type==="highest_scoring_period"||type==="win_all_periods")return false;
  if(type==="first_goal_team"&&(Number(game.away_score||0)+Number(game.home_score||0)>0))return false;
  const pm=/^P([123])$/.exec(period);if(pm){const p=Number(pm[1]);if(current&&p<current)return false;if(current&&p>current+1)return false;}
  const line=Number(m.line),side=String(m.side||"").toLowerCase();
  if(type==="game_total"&&Number.isFinite(line)){
    const total=pm?periodScore(snapshot,Number(pm[1]),game.away_tri,game.home_tri).total:Number(game.away_score||0)+Number(game.home_score||0);
    if(side==="under"&&total>line)return false;if(side==="over"&&total>line)return false;
  }
  if(type==="team_total"&&Number.isFinite(line)){
    const team=String(m.subject||"").toUpperCase(),goals=team===game.away_tri?Number(game.away_score||0):team===game.home_tri?Number(game.home_score||0):null;
    if(goals!==null&&((side==="under"&&goals>line)||(side==="over"&&goals>line)))return false;
  }
  return ["moneyline","handicap","game_total","team_total","period_1_result","period_2_result","period_3_result","double_chance","both_teams_score","team_goal_bucket","result_total_combo","first_goal_team"].includes(type);
}

function liveStateText(snapshot){const g=snapshot?.game||{};return `${g.away_tri} ${g.away_score}:${g.home_score} ${g.home_tri} · ${g.period_number||"—"}-й период${g.time_remaining?` · ${g.time_remaining}`:""}`}
function liveStateEvidence(snapshot){const g=snapshot?.game||{};return {away_tri:g.away_tri,home_tri:g.home_tri,away_score:Number(g.away_score||0),home_score:Number(g.home_score||0),period:Number(g.period_number||0),time_remaining:g.time_remaining||null,seconds_remaining:finiteOrNull(g.seconds_remaining)}}
function periodScore(snapshot,p,team,opp){
  const rows=Array.isArray(snapshot?.live_context?.periods)?snapshot.live_context.periods:[];
  const row=rows.find(x=>Number(x.period)===Number(p))||{};const goals=row.goals_by_team||{};
  const teamGoals=Number(goals[team]||0),oppGoals=Number(goals[opp]||0);
  return {team:teamGoals,opp:oppGoals,total:teamGoals+oppGoals,diff:teamGoals-oppGoals};
}
function periodTotal(row,p){return Number(row?.[`p${p}_goals_for`]||0)+Number(row?.[`p${p}_goals_against`]||0)}
function resultRate(rows,p,mode){return boolRate((rows||[]).slice(0,10),r=>{const gf=Number(r?.[`p${p}_goals_for`]||0),ga=Number(r?.[`p${p}_goals_against`]||0);return mode==="win"?gf>ga:gf<ga})}
function boolRate(rows,pred){let hits=0,sample=0;for(const r of rows||[]){sample++;if(pred(r))hits++}return {hits,sample,rate:sample?hits/sample:0}}
function rateByValue(rows,valueFn,side,line){let hits=0,sample=0,pushes=0;for(const r of (rows||[]).slice(0,10)){const v=Number(valueFn(r));if(!Number.isFinite(v))continue;if(Math.abs(v-line)<1e-9){pushes++;continue}sample++;if(side==="over"?v>line:v<line)hits++}return {hits,sample,pushes,rate:sample?hits/sample:0}}
function rowsFor(map,team){return map.get(String(team||"").toUpperCase())||[]}
function opponent(game,team){return String(team).toUpperCase()===String(game.home_tri).toUpperCase()?game.away_tri:game.home_tri}
function freshLiveMarket(m,nowMs,maxAgeMs){if(!(m?.is_live===true||Number(m?.is_live||0)===1))return false;const odds=Number(m?.odds),at=Date.parse(String(m?.updated_at||""));if(!Number.isFinite(odds)||odds<MIN_ODDS||!Number.isFinite(at))return false;const age=nowMs-at;return age>=-60_000&&age<=maxAgeMs}
function hasRealPrice(card){const m=card?.market||{},odds=Number(m.odds);return Number.isFinite(odds)&&odds>=MIN_ODDS&&m.odds_is_demo===false&&m.odds_source==="provider_live"}
function dedupeByProviderSelection(cards){const seen=new Set(),out=[];for(const c of cards||[]){const m=c?.market||{},key=String(m.market_id||m.selection_id||[m.type,m.period,m.subject,m.side,m.line].join(":"));if(!key||seen.has(key))continue;seen.add(key);out.push(c)}return out}
function marketLabel(type,period,subject,side,line){const p=period==="P1"?"1-Й ПЕРИОД · ":period==="P2"?"2-Й ПЕРИОД · ":period==="P3"?"3-Й ПЕРИОД · ":"";if(type==="moneyline"||/^period_[123]_result$/.test(type))return `${p}ПОБЕДА ${subject||""}`.trim();if(type==="game_total")return `${p}${side==="under"?"ТМ":"ТБ"} ${fmtLine(line)}`.trim();if(type==="team_total")return `${p}${subject} ${side==="under"?"ТМ":"ТБ"} ${fmtLine(line)}`.trim();if(type==="handicap")return `${p}${subject} ФОРА ${fmtSigned(line)}`.trim();return [p,type,subject,side,fmtLine(line)].filter(Boolean).join(" ").trim()}
function fmtLine(v){const n=Number(v);return Number.isFinite(n)?String(n).replace(".",","):""}
function fmtSigned(v){const n=Number(v);return Number.isFinite(n)?`${n>0?"+":""}${String(n).replace(".",",")}`:""}
function resolveNow(v){if(v instanceof Date)return v.getTime();if(typeof v==="number"&&Number.isFinite(v))return v;if(typeof v==="string"&&Number.isFinite(Date.parse(v)))return Date.parse(v);return Date.now()}
function finitePositive(v,fallback){const n=Number(v);return Number.isFinite(n)&&n>0?n:fallback}
function finiteOrNull(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function clamp(v,min,max){return Math.max(min,Math.min(max,Number(v)||0))}
