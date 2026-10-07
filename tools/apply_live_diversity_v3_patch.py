from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise SystemExit(f"PATCH_MISS {path}: {old[:140]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement):
    text = read(path)
    new, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"PATCH_REGEX_MISS {path}: count={count} pattern={pattern[:120]!r}")
    write(path, new)


# ---------------------------------------------------------------------------
# New low-read live context engine: period history + current score + pregame
# archive repriced against the current real Winline line.
# ---------------------------------------------------------------------------
write("cloudflare-worker/src/live-context-engine.js", r'''import { applyWinlineMarkets } from "./winline-market-adapter.js";
import { loadBroadcastPregameArchive } from "./broadcast-insight-history.js";

const MIN_SAMPLE=8;
const MIN_ODDS=1.50;

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
  const rowsByTeam=new Map([
    [String(game.away_tri).toUpperCase(),featureResults?.[0]?.results||[]],
    [String(game.home_tri).toUpperCase(),featureResults?.[1]?.results||[]],
  ]);
  const history=buildProviderHistoryCards(snapshot,providerMarkets,rowsByTeam,options);
  const repriced=repricePregameLiveCards(snapshot,archive?.cards||[],providerMarkets,options);
  return mergeLiveInsightCards(history,repriced);
}

function recentFeatures(db,team,gamePk){
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,is_home,final_win,final_goals_for,final_goals_against,
           final_goal_diff,total_goals,p1_goals_for,p1_goals_against,
           p2_goals_for,p2_goals_against,p3_goals_for,p3_goals_against
    FROM team_game_features
    WHERE team_tri=? AND game_pk<>?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT 12;
  `).bind(team,gamePk);
}

export function buildProviderHistoryCards(snapshot,providerMarkets,rowsByTeamInput,options={}){
  const game=snapshot?.game||{},nowMs=resolveNow(options.now),maxAgeMs=finitePositive(options.market_max_age_ms,90_000);
  const rowsByTeam=rowsByTeamInput instanceof Map?rowsByTeamInput:new Map(Object.entries(rowsByTeamInput||{}));
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
    const cap=origin==="shot_support"?1:origin==="pregame_repriced"?4:origin.startsWith("period_")?4:3;
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
''')

# ---------------------------------------------------------------------------
# Live engine: shots become one secondary next-goal signal only. They no longer
# create match-winner or period-total advice.
# ---------------------------------------------------------------------------
live_path="cloudflare-worker/src/live-betting-engine.js"
regex_once(
    live_path,
    r'export function buildProviderDrivenLiveCards\(snapshot,liveMarkets,existing=\[\],options=\{\}\)\{.*?\n\}\nfunction providerLiveCardMarket',
    r'''export function buildProviderDrivenLiveCards(snapshot,liveMarkets,existing=[],options={}){
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
function providerLiveCardMarket'''
)

regex_once(
    live_path,
    r'export function buildLiveContext\(game,shots\)\{.*?\n\}\n\nexport function buildLiveCards',
    r'''export function buildLiveContext(game,shots){
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

export function buildLiveCards'''
)

regex_once(
    live_path,
    r'export function buildLiveCards\(game, shots\) \{.*?\n\}\n\nfunction addShotWindowCard',
    r'''export function buildLiveCards(game, shots) {
  if (!game?.home_tri || !game?.away_tri || !Array.isArray(shots)) return [];
  const cards = [];
  // V3 policy: shot pressure is never enough for moneyline/totals. Keep at most
  // one very strong short-horizon signal, and only for the next-goal market.
  addRecentMinutesCard(cards, game, shots, 10, 10, 0.75);
  return dedupe(cards).sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,1);
}

function addShotWindowCard'''
)

regex_once(
    live_path,
    r'function addRecentMinutesCard\(cards, game, shots, minutes, minShots, minShare\) \{.*?\n\}\n\nfunction addCurrentPeriodCard',
    r'''function addRecentMinutesCard(cards, game, shots, minutes, minShots, minShare) {
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

function addCurrentPeriodCard'''
)

# ---------------------------------------------------------------------------
# Worker route: enrich every live tick with low-read historical context.
# ---------------------------------------------------------------------------
replace_once(
    "cloudflare-worker/src/worker-entry.js",
    'import { buildLiveGameSnapshot, attachLiveWinlineMarkets } from "./live-betting-engine.js";\n',
    'import { buildLiveGameSnapshot, attachLiveWinlineMarkets } from "./live-betting-engine.js";\nimport { buildLiveHistoricalContext, mergeLiveInsightCards, summarizeLiveCardMix } from "./live-context-engine.js";\n',
)
replace_once(
    "cloudflare-worker/src/worker-entry.js",
    '''        snapshot=attachLiveWinlineMarkets(snapshot,providerMarkets,{
          market_max_age_ms:90*1000,
        });
        const quoteAt=Date.parse(String(snapshot.provider_live_updated_at||"")),quoteAge=Number.isFinite(quoteAt)?Math.max(0,Math.round((Date.now()-quoteAt)/1000)):null;''',
    '''        snapshot=attachLiveWinlineMarkets(snapshot,providerMarkets,{
          market_max_age_ms:90*1000,
        });
        try{
          const contextCards=await buildLiveHistoricalContext(env.DB,snapshot,providerMarkets,{market_max_age_ms:90*1000});
          snapshot.cards=mergeLiveInsightCards(contextCards,snapshot.cards||[]);
          snapshot.live_mix=summarizeLiveCardMix(snapshot.cards);
        }catch(error){
          console.error("broadcast live historical context degraded",error);
          snapshot.live_mix=summarizeLiveCardMix(snapshot.cards||[]);
        }
        const quoteAt=Date.parse(String(snapshot.provider_live_updated_at||"")),quoteAge=Number.isFinite(quoteAt)?Math.max(0,Math.round((Date.now()-quoteAt)/1000)):null;'''
)

# ---------------------------------------------------------------------------
# UI: diversify featured cards and explicitly label origin. Shot-based card is
# capped at one in the featured four.
# ---------------------------------------------------------------------------
dashboard="cloudflare-worker/src/broadcast-dashboard-v2.js"
replace_once(
    dashboard,
    '''function cardSummaryHtml(c){
  const team=cardTeam(c),odds=Number(c?.market?.odds),priced=hasRealWinlinePrice(c),profit=profitParts(odds),score=airScore(c),tone=airTone(score);
  const group=c?.broadcast_group==='h2h'?'ЛИЧНЫЕ ВСТРЕЧИ':'ФОРМА КОМАНД';''',
    '''function liveCardGroup(c){const origin=String(c?.live_origin||'');if(origin==='shot_support')return'БРОСКИ · ДОП.';if(origin==='pregame_repriced')return'ПРЕДМАТЧЕВЫЙ СИГНАЛ';if(origin.startsWith('period_'))return'СТАТИСТИКА ПО ПЕРИОДАМ';if(origin==='team_total_history'||origin==='game_total_history')return'ГОЛЫ И ТОТАЛЫ';if(origin==='moneyline_history')return'ФОРМА + СЧЁТ';return c?.broadcast_group==='h2h'?'ЛИЧНЫЕ ВСТРЕЧИ':'ФОРМА КОМАНД'}
function cardSummaryHtml(c){
  const team=cardTeam(c),odds=Number(c?.market?.odds),priced=hasRealWinlinePrice(c),profit=profitParts(odds),score=airScore(c),tone=airTone(score);
  const group=liveCardGroup(c);'''
)

regex_once(
    dashboard,
    r'function renderCombinedCards\(\)\{.*?\n\}\nfunction cardKey',
    r'''function renderCombinedCards(){
  const liveMode=isLiveGame(),featured=[],seen=new Set(),originCounts=new Map();
  const primary=liveMode?[...(liveCards||[])].sort((a,b)=>airScore(b)-airScore(a)):featuredCards||[];
  const tryFeatured=(c,enforceDiversity=true)=>{
    if(!hasRealWinlinePrice(c))return false;
    const k=cardKey(c);if(seen.has(k))return false;
    if(liveMode){
      const origin=String(c?.live_origin||'live_other'),used=Number(originCounts.get(origin)||0);
      if(origin==='shot_support'&&used>=1)return false;
      if(enforceDiversity&&used>=2)return false;
      originCounts.set(origin,used+1);
    }
    seen.add(k);featured.push({...c,__featured:true});return true;
  };
  for(const c of primary){tryFeatured(c,true);if(featured.length>=4)break}
  if(featured.length<4){for(const c of primary){tryFeatured(c,false);if(featured.length>=4)break}}
  const extras=[];
  const pool=liveMode?(liveCards||[]):[...(liveCards||[]),...(historicalCards||[])];
  for(const c of pool){
    if(!hasRealWinlinePrice(c))continue;
    const k=cardKey(c);if(seen.has(k))continue;seen.add(k);
    extras.push({...c,__featured:false});
  }
  extras.sort((a,b)=>{
    const shot=Number(a?.live_origin==='shot_support')-Number(b?.live_origin==='shot_support');
    if(shot)return shot;
    return airScore(b)-airScore(a);
  });
  const visible=[...featured,...extras.slice(0,32)];
  renderCards(visible);
  syncQueueSummaryFromCards(selected,visible);
  const priced=visible.filter(hasRealWinlinePrice).length,shotCount=visible.filter(x=>x?.live_origin==='shot_support').length,sub=document.querySelector('.psub');
  if(sub)sub.textContent=liveMode?`4 рекомендуемые · ещё ${Math.max(0,visible.length-featured.length)} вариантов · бросковых ${shotCount} · линий WINLINE: ${priced}/${visible.length}`:`4 рекомендуемые · ещё ${Math.max(0,visible.length-featured.length)} вариантов · линий WINLINE: ${priced}/${visible.length}`;
}
function cardKey'''
)
replace_once(dashboard,"section(isLiveGame()?'LIVE-СИГНАЛЫ':'ФОРМА КОМАНД',form,isLiveGame()?'Жду live-сигналы с актуальной линией':'Не нашлось двух понятных карточек по текущей форме')+","section(isLiveGame()?'LIVE · ПЕРИОДЫ И ФОРМА':'ФОРМА КОМАНД',form,isLiveGame()?'Жду live-сигналы с актуальной линией':'Не нашлось двух понятных карточек по текущей форме')+")
replace_once(dashboard,"section(isLiveGame()?'ЕЩЁ LIVE':'ЛИЧНЫЕ ВСТРЕЧИ',h2h,isLiveGame()?'Пока нет дополнительных live-сигналов':'Недостаточно очных матчей для двух сильных карточек')+","section(isLiveGame()?'LIVE · ДРУГИЕ УГЛЫ':'ЛИЧНЫЕ ВСТРЕЧИ',h2h,isLiveGame()?'Пока нет дополнительных live-сигналов':'Недостаточно очных матчей для двух сильных карточек')+")

# ---------------------------------------------------------------------------
# Tests: shots cannot create moneyline; period/form/history must create diverse
# exact-line live cards.
# ---------------------------------------------------------------------------
write("tests/validate_live_market_enrichment.mjs", r'''import { strict as assert } from "node:assert";
import fs from "node:fs";
import { buildLiveCards, attachLiveWinlineMarkets } from "../cloudflare-worker/src/live-betting-engine.js";
import { buildProviderHistoryCards, mergeLiveInsightCards, repricePregameLiveCards } from "../cloudflare-worker/src/live-context-engine.js";

const game={game_pk:2026020001,home_tri:"CAR",away_tri:"FLA",home_score:1,away_score:1,period_number:2,game_state:"LIVE",seconds_remaining:600,time_remaining:"10:00"};
const shots=[];for(let i=0;i<10;i++)shots.push({sort_order:i+1,event_type:"shot-on-goal",team_tri:i<8?"CAR":"FLA",period_number:2,period_type:"REG",elapsed_seconds:1200+i*30});
const raw=buildLiveCards(game,shots);
assert.ok(raw.some(c=>c.market?.type==="next_goal_team"&&c.market?.subject==="CAR"),"elite shot pressure may create one next-goal card");
assert.equal(raw.some(c=>c.market?.type==="moneyline"),false,"shots must never create a match-winner card");
assert.equal(raw.some(c=>c.market?.type==="game_total"),false,"shots must never create a total card");
assert.ok(raw.every(c=>Number(c.score)<=70&&c.live_origin==="shot_support"),"shot cards must be secondary");

const now=new Date().toISOString();
const shotProvider=[
  {provider:"winline",market_type:"next_goal_team",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.91,status:"open",is_live:true,updated_at:now,market_id:"shot-next"},
  {provider:"winline",market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.84,status:"open",is_live:true,updated_at:now,market_id:"shot-ml"},
];
const enriched=attachLiveWinlineMarkets({ok:true,game,cards:raw,live_context:{recent_5m:{total:10,share:.8,leader:"CAR",leader_shots:8,opponent:"FLA",opponent_shots:2,minutes:5},recent_10m:{total:10,share:.8,leader:"CAR",leader_shots:8,opponent:"FLA",opponent_shots:2,minutes:10}}},shotProvider,{now,market_max_age_ms:300000});
assert.ok(enriched.cards.some(c=>c.market.type==="next_goal_team"&&c.market.odds===1.91));
assert.equal(enriched.cards.some(c=>c.market.type==="moneyline"),false,"provider fallback must not turn shots into moneyline");

const mkRows=(team,strong=true)=>Array.from({length:10},(_,i)=>({
  game_pk:1000+i,is_home:i%2,final_win:strong?(i<7?1:0):(i<4?1:0),final_goals_for:strong?(i<7?4:2):(i<4?4:2),final_goals_against:strong?(i<7?2:4):(i<4?2:4),
  final_goal_diff:strong?(i<7?2:-2):(i<4?2:-2),total_goals:i<7?7:4,
  p1_goals_for:i<6?2:0,p1_goals_against:i<6?0:1,
  p2_goals_for:strong?(i<7?2:0):(i<4?2:0),p2_goals_against:strong?(i<7?0:1):(i<4?0:1),
  p3_goals_for:i<6?1:0,p3_goals_against:i<6?0:1,
}));
const rows=new Map([["CAR",mkRows("CAR",true)],["FLA",mkRows("FLA",false)]]);
const snapshot={ok:true,game,live_context:{periods:[{period:1,goals_by_team:{CAR:0,FLA:0},goals_total:0},{period:2,goals_by_team:{CAR:1,FLA:0},goals_total:1},{period:3,goals_by_team:{CAR:0,FLA:0},goals_total:0}],current_period:{period:2,goals_by_team:{CAR:1,FLA:0},goals_total:1}}};
const provider=[
  {provider:"winline",market_type:"period_2_result",period:"P2",subject:"CAR",side:"CAR",line:null,odds:2.05,status:"open",is_live:true,updated_at:now,market_id:"p2-car",selection_id:"p2-car"},
  {provider:"winline",market_type:"game_total",period:"P2",subject:null,side:"over",line:1.5,odds:1.88,status:"open",is_live:true,updated_at:now,market_id:"p2-over",selection_id:"p2-over"},
  {provider:"winline",market_type:"team_total",period:"GAME",subject:"CAR",side:"over",line:2.5,odds:1.95,status:"open",is_live:true,updated_at:now,market_id:"car-tt",selection_id:"car-tt"},
  {provider:"winline",market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.90,status:"open",is_live:true,updated_at:now,market_id:"car-ml",selection_id:"car-ml"},
];
const history=buildProviderHistoryCards(snapshot,provider,rows,{now,market_max_age_ms:300000});
assert.ok(history.some(c=>c.live_origin==="period_result_history"),"period result history must participate in live");
assert.ok(history.some(c=>c.live_origin==="period_total_history"),"period total history must participate in live");
assert.ok(history.some(c=>c.live_origin==="team_total_history"),"team/opponent scoring history must participate in live");
assert.ok(history.some(c=>c.live_origin==="moneyline_history"),"pregame form + current score may support moneyline");
assert.ok(history.every(c=>!/ПО БРОСКАМ/.test(c.broadcast_title||"")),"primary historical live cards must not be shot-led");

const pregame=[{id:"pre-ml",air_score:82,broadcast_title:"CAR выиграл 7 из последних 10 матчей",evidence:{sample:10,hits:7},market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null}}];
const repriced=repricePregameLiveCards(snapshot,pregame,provider,{now,market_max_age_ms:300000});
assert.equal(repriced.length,1);assert.equal(repriced[0].live_origin,"pregame_repriced");assert.equal(repriced[0].market.odds,1.90);

const mixed=mergeLiveInsightCards([...history,...repriced],enriched.cards);
assert.ok(mixed.length>=4,"live queue should have several non-shot angles");
assert.ok(mixed.filter(c=>c.live_origin==="shot_support").length<=1,"live mix caps shots at one card");
assert.ok(mixed.filter(c=>c.live_origin!=="shot_support").length>=3,"non-shot context must dominate live queue");

const dash=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-dashboard-v2.js',import.meta.url),'utf8');
for(const needle of ["origin==='shot_support'&&used>=1","СТАТИСТИКА ПО ПЕРИОДАМ","ПРЕДМАТЧЕВЫЙ СИГНАЛ","LIVE · ПЕРИОДЫ И ФОРМА"])assert.ok(dash.includes(needle),'dashboard diversity marker missing '+needle);
console.log("LIVE_MARKET_ENRICHMENT_V3_OK");
''')

write("tests/validate_live_center_stage2.mjs", r'''import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { buildLiveGameSnapshot, buildLiveCards, buildProviderDrivenLiveCards } from '../cloudflare-worker/src/live-betting-engine.js';

const plays=[];let order=1;
const add=(type,team,minute,extra={})=>plays.push({sortOrder:order++,eventId:order,typeDescKey:type,details:{eventOwnerTeamId:team,...extra},periodDescriptor:{number:1,periodType:'REG'},timeInPeriod:minute});
for(const t of ['03:00','03:40','04:10','04:40','05:10','05:40','06:10','06:40'])add('shot-on-goal',1,t);
for(const t of ['03:20','06:20'])add('shot-on-goal',2,t);
add('goal',1,'06:50');add('hit',1,'07:00');add('hit',2,'07:10');add('penalty',2,'07:20',{duration:2});add('faceoff',1,'07:30');add('faceoff',2,'08:00');
const payload={id:2026020001,season:20262027,gameType:2,gameState:'LIVE',homeTeam:{id:2,abbrev:'ANA',score:1,sog:8},awayTeam:{id:1,abbrev:'FLA',score:1,sog:12},periodDescriptor:{number:1,periodType:'REG'},clock:{timeRemaining:'12:00',secondsRemaining:720,running:true,inIntermission:false},plays};
const fakeFetch=async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
const snap=await buildLiveGameSnapshot(2026020001,fakeFetch);
assert.equal(snap.game.away_score,1);assert.equal(snap.game.home_score,1);assert.equal(snap.live_stats.away.shots,12);assert.equal(snap.live_stats.home.shots,8);assert.equal(snap.live_stats.home.pim,2);assert.equal(snap.live_stats.away.faceoff_pct,0.5);assert.equal(snap.live_context.periods[0].goals_by_team.FLA,1);

const weakGame={...snap.game,home_score:2,away_score:1};const weakShots=[];for(let i=0;i<6;i++)weakShots.push({sort_order:i+1,event_type:'shot-on-goal',team_tri:i<5?'FLA':'ANA',period_number:1,elapsed_seconds:300+i*20});
assert.equal(buildLiveCards(weakGame,weakShots).some(c=>c.market?.type==='moneyline'),false,'shots must never create match-winner card');

const provider=[{provider:'winline',event_id:'1',market_id:'m1',selection_id:'m1',market_type:'moneyline',period:'GAME',subject:'FLA',side:'FLA',line:null,odds:2.9,status:'open',is_live:true,updated_at:new Date().toISOString()}];
const fallback=buildProviderDrivenLiveCards(snap,provider,[],{now:Date.now(),max_age_ms:90000});
assert.equal(fallback.length,0,'shot-based provider fallback must not manufacture moneyline');

const dash=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-dashboard-v2.js',import.meta.url),'utf8');for(const needle of ['applyLiveGameSnapshot(l)','renderMetrics(currentData,l.live_stats||null)','score.innerHTML=esc(g.away_score)'])assert.ok(dash.includes(needle),'dashboard missing '+needle);
const overlay=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-operator.js',import.meta.url),'utf8');for(const needle of ['statePollUrl()','failures>=12','imageFailures>=4','Date.now()-lastOk>20000'])assert.ok(overlay.includes(needle),'overlay watchdog missing '+needle);
console.log('LIVE_CENTER_STAGE2_V3_OK');
''')

# Plan / permanent project note.
plan="docs/BROADCAST_CONTROL_ROOM_V2_PLAN.md"
text=read(plan)
if "## P8 — live diversity" not in text:
    text += r'''

## P8 — live diversity: periods and pregame context over shot volume
- [x] Shot pressure can no longer create moneyline or total advice by itself.
- [x] Keep at most one shot-led featured card; shots are a secondary next-goal signal only.
- [x] Re-evaluate exact live Winline period-result markets against each team's historical result in that same period.
- [x] Re-evaluate exact live period totals from both teams' historical P1/P2/P3 goal distributions.
- [x] Add live team totals from team scoring + opponent conceding history, with current score/time sanity checks.
- [x] Add live game totals from both teams' recent goal distributions, filtered by the current score and late-game feasibility.
- [x] Add moneyline only when pregame form + opponent form + current score agree; shots are excluded from this decision.
- [x] Reprice saved pregame signals against the current live Winline line when the market is still logically relevant.
- [x] Diversify the top four live cards by origin and label period / pregame / totals / shot-support angles explicitly in the UI.
- [x] Cover the no-shot-moneyline invariant and period/pregame live mix with mandatory product CI.
'''
    write(plan,text)

print("LIVE_DIVERSITY_V3_PATCH_APPLIED")
