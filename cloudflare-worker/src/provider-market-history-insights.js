
import { normalizeWinlineMarket } from "./winline-market-adapter.js";

const WINDOWS=[10,20,40];
const MAX_HISTORY=80;

export async function buildProviderMarketHistoryInsights(db,game,providerMarkets=[]){
  if(!db||!game?.scheduled_start_utc||!game?.away_tri||!game?.home_tri||!Array.isArray(providerMarkets)||!providerMarkets.length)return[];

  const [awayR,homeR]=await db.batch([
    history(db,game.away_tri,game.scheduled_start_utc),
    history(db,game.home_tri,game.scheduled_start_utc),
  ]);
  const rowsByTeam={
    [game.away_tri]:awayR.results||[],
    [game.home_tri]:homeR.results||[],
  };

  return evaluateProviderMarketHistoryRows(game,rowsByTeam,providerMarkets);
}

export function evaluateProviderMarketHistoryRows(game,rowsByTeam,providerMarkets=[]){
  const markets=dedupeMarkets(
    (providerMarkets||[])
      .filter(m=>!(m?.is_live===true||Number(m?.is_live||0)===1))
      .map(normalizeWinlineMarket)
      .filter(Boolean)
  );

  const out=[];
  for(const market of markets){
    for(const window of WINDOWS){
      const result=evaluateMarket(market,game,rowsByTeam||{},window);
      if(!result)continue;
      const threshold=displayThreshold(market);
      if(result.rate<threshold||result.decisions<minimumDecisions(window))continue;
      out.push(makeCard(game,market,result,window));
    }
  }
  return out.sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,900);
}

function history(db,team,before){
  return db.prepare(`
    SELECT game_pk,scheduled_start_utc,team_tri,opponent_tri,is_home,
           final_goals_for,final_goals_against,total_goals,final_goal_diff,final_win,
           regulation_goals_for,regulation_goals_against,regulation_goal_diff,regulation_result,
           p1_goals_for,p1_goals_against,p2_goals_for,p2_goals_against,p3_goals_for,p3_goals_against,
           score_after_p1_diff,score_after_p2_diff,first_goal_for
    FROM team_game_features
    WHERE team_tri=? AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT ${MAX_HISTORY};
  `).bind(team,before);
}

function evaluateMarket(m,game,rowsByTeam,window){
  const type=String(m.market_type||"");
  const period=String(m.period||"GAME");
  const side=String(m.side||"").toLowerCase();
  const subject=String(m.subject||"").toUpperCase()||null;
  const line=finite(m.line);

  if(type==="game_total"){
    return combinedTeamSlices(game,rowsByTeam,window,row=>{
      const total=periodTotal(row,period);
      if(total===null||line===null)return null;
      return settleTotal(total,side,line);
    });
  }

  if(type==="team_total"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const goals=periodGoalsFor(row,period);
      if(goals===null||line===null)return null;
      return settleTotal(goals,side,line);
    });
  }

  if(type==="handicap"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const diff=periodGoalDiff(row,period);
      if(diff===null||line===null)return null;
      return settleHandicap(diff,line);
    });
  }

  if(type==="moneyline"){
    if(side==="draw"||!subject){
      return combinedTeamSlices(game,rowsByTeam,window,row=>{
        if(period==="REG")return String(row.regulation_result)==="T"?"win":"loss";
        return null;
      });
    }
    if(!rowsByTeam[subject])return null;
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      if(period==="REG")return String(row.regulation_result)==="W"?"win":"loss";
      if(period==="GAME")return Number(row.final_win)===1?"win":"loss";
      return null;
    });
  }

  if(/^period_[123]_result$/.test(type)){
    const p=Number(type.match(/^period_([123])_result$/)?.[1]||period.replace("P",""));
    if(!p)return null;
    if(side==="draw"||!subject){
      return combinedTeamSlices(game,rowsByTeam,window,row=>{
        const d=periodGoalDiff(row,"P"+p);return d===null?null:(d===0?"win":"loss");
      });
    }
    if(!rowsByTeam[subject])return null;
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const d=periodGoalDiff(row,"P"+p);return d===null?null:(d>0?"win":"loss");
    });
  }

  if(type==="double_chance"){
    if(side==="no_draw"){
      return combinedTeamSlices(game,rowsByTeam,window,row=>{
        const r=String(row.regulation_result||"");return r?r!=="T"?"win":"loss":null;
      });
    }
    if(side==="team_or_draw"&&subject&&rowsByTeam[subject]){
      return oneTeamSlice(rowsByTeam[subject],window,row=>{
        const r=String(row.regulation_result||"");return r?r!=="L"?"win":"loss":null;
      });
    }
  }

  if(type==="both_teams_score"){
    return combinedTeamSlices(game,rowsByTeam,window,row=>{
      const yes=Number(row.final_goals_for)>=1&&Number(row.final_goals_against)>=1;
      return side==="yes"?(yes?"win":"loss"):side==="no"?(yes?"loss":"win"):null;
    });
  }

  if(type==="first_goal_team"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>Number(row.first_goal_for)===1?"win":"loss");
  }

  if(type==="team_goal_bucket"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      const goals=periodGoalsFor(row,period);if(goals===null)return null;
      if(side==="0_1")return goals<=1?"win":"loss";
      if(side==="2")return goals===2?"win":"loss";
      if(side==="3_plus")return goals>=3?"win":"loss";
      return null;
    });
  }

  if(type==="highest_scoring_period"){
    const target=Number(side.replace("P",""));
    if(!target)return null;
    const source=subject&&rowsByTeam[subject]?rowsByTeam[subject]:null;
    const settle=row=>{
      const values=[1,2,3].map(p=>periodGoalsFor(row,"P"+p));
      if(values.some(v=>v===null))return null;
      const max=Math.max(...values);
      const winners=values.map((v,i)=>v===max?i+1:0).filter(Boolean);
      if(winners.length!==1)return "push";
      return winners[0]===target?"win":"loss";
    };
    return source?oneTeamSlice(source,window,settle):combinedTeamSlices(game,rowsByTeam,window,settle);
  }

  if(type==="win_all_periods"&&subject&&rowsByTeam[subject]){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      for(let p=1;p<=3;p++){const d=periodGoalDiff(row,"P"+p);if(d===null)return null;if(d<=0)return "loss";}
      return "win";
    });
  }

  if(type==="result_total_combo"&&subject&&rowsByTeam[subject]&&line!==null){
    return oneTeamSlice(rowsByTeam[subject],window,row=>{
      if(Number(row.final_win)!==1)return "loss";
      const total=Number(row.total_goals);
      return settleTotal(total,side,line);
    });
  }

  return null;
}

function oneTeamSlice(rows,window,settler){
  const sample=(rows||[]).slice(0,window);
  if(sample.length<Math.min(8,window))return null;
  return aggregate(sample,settler,{perspectives:1});
}

function combinedTeamSlices(game,rowsByTeam,window,settler){
  const away=(rowsByTeam[game.away_tri]||[]).slice(0,window);
  const home=(rowsByTeam[game.home_tri]||[]).slice(0,window);
  if(away.length<Math.min(8,window)||home.length<Math.min(8,window))return null;
  const a=aggregate(away,settler,{perspectives:1});
  const h=aggregate(home,settler,{perspectives:1});
  if(!a||!h)return null;

  // A recent head-to-head can occur in both team slices. Count that game once
  // in the combined hit-rate, while retaining each team's separate perspective
  // for the operator explanation.
  const uniqueRows=new Map();
  for(const row of [...away,...home]){
    const key=Number(row?.game_pk);
    if(Number.isFinite(key)&&!uniqueRows.has(key))uniqueRows.set(key,row);
  }
  const combined=aggregate([...uniqueRows.values()],settler,{perspectives:2});
  if(!combined)return null;
  return {
    ...combined,
    away:{hits:a.hits,decisions:a.decisions,pushes:a.pushes,rate:a.rate,sample:a.sample},
    home:{hits:h.hits,decisions:h.decisions,pushes:h.pushes,rate:h.rate,sample:h.sample},
  };
}

function aggregate(rows,settler,extra={}){
  let hits=0,losses=0,pushes=0,current_streak=0,streakOpen=true;
  const game_pks=[];
  for(const row of rows){
    const result=settler(row);
    if(result===null||result===undefined)continue;
    game_pks.push(Number(row.game_pk));
    if(result==="win"){
      hits++;
      if(streakOpen)current_streak++;
    }else if(result==="push"){
      pushes++;
      streakOpen=false;
    }else{
      losses++;
      streakOpen=false;
    }
  }
  const decisions=hits+losses,sample=hits+losses+pushes;
  if(!sample||!decisions)return null;
  return {hits,losses,pushes,decisions,sample,rate:hits/decisions,current_streak,game_pks,...extra};
}

function makeCard(game,m,r,window){
  const score=qualityScore(m,r,window);
  const title=marketHistoryTitle(m,r,window);
  return {
    id:`${game.game_pk}:provider-history:${marketKey(m)}:w${window}`,
    insight_type:"provider_exact_history",
    category:"provider_history",
    kind:"history",
    timing:"pregame",
    score,
    eyebrow:eyebrow(m,window),
    value:`${r.hits}/${r.decisions}`,
    title,
    explanation:operatorExplanation(m,r,game),
    evidence:{
      window,
      sample:r.sample,
      decisions:r.decisions,
      hits:r.hits,
      losses:r.losses,
      pushes:r.pushes,
      hit_rate:r.rate,
      current_streak:r.current_streak||0,
      away:r.away||null,
      home:r.home||null,
      exact_provider_line:true,
      provider_market_key:marketKey(m),
      game_pks:r.game_pks,
      feature_layer:"provider_exact_market_history_v1",
    },
    market:{
      type:m.market_type,period:m.period,subject:m.subject,side:m.side,line:m.line,
      label:marketLabel(m),
      odds:m.odds,provider:m.provider,odds_is_demo:false,odds_source:"provider_live",
      event_id:m.event_id,market_id:m.market_id,selection_id:m.selection_id,updated_at:m.updated_at,deeplink:m.deeplink,
    },
  };
}

function displayThreshold(m){
  const type=String(m.market_type||"");
  const side=String(m.side||"").toLowerCase();
  if((type==="moneyline"||/^period_[123]_result$/.test(type))&&side==="draw")return .34;
  if(type==="highest_scoring_period")return .34;
  if(type==="win_all_periods")return .18;
  if(type==="result_total_combo")return .35;
  if(type==="team_goal_bucket")return .45;
  if(type==="double_chance")return .62;
  return .58;
}
function minimumDecisions(window){return window>=40?24:window>=20?14:7}
function qualityScore(m,r,window){
  const sampleBonus=window>=40?9:window>=20?6:3;
  const perspectives=r.perspectives===2?5:0;
  const pushPenalty=Math.min(8,r.pushes*1.5);
  const price=Number(m.odds);
  const priceBonus=Number.isFinite(price)&&price>=1.55&&price<=3?5:0;
  return Math.max(55,Math.min(97,Math.round(56+r.rate*26+sampleBonus+perspectives+priceBonus-pushPenalty)));
}

function eyebrow(m,window){
  const type=String(m.market_type||"");
  const period=String(m.period||"GAME");
  const prefix=period==="P1"?"1-Й ПЕРИОД":period==="P2"?"2-Й ПЕРИОД":period==="P3"?"3-Й ПЕРИОД":period==="REG"?"60 МИНУТ":"ТОЧНАЯ ЛИНИЯ";
  const family=
    type==="game_total"?"ТОТАЛ":
    type==="team_total"?"КОМАНДНЫЙ ТОТАЛ":
    type==="handicap"?"ФОРА":
    type==="moneyline"||/^period_[123]_result$/.test(type)?"ИСХОД":
    type==="double_chance"?"ДВОЙНОЙ ШАНС":
    type==="both_teams_score"?"ОБЕ ЗАБЬЮТ":
    type==="first_goal_team"?"ПЕРВЫЙ ГОЛ":
    type==="team_goal_bucket"?"ГОЛЫ КОМАНДЫ":
    type==="highest_scoring_period"?"РЕЗУЛЬТАТИВНЫЙ ПЕРИОД":
    type==="win_all_periods"?"ВСЕ ПЕРИОДЫ":
    type==="result_total_combo"?"ПОБЕДА + ТОТАЛ":"WINLINE";
  return `${prefix} · ${family} · ${window} МАТЧЕЙ`;
}

function marketHistoryTitle(m,r,window){
  const t=String(m.market_type||""),p=String(m.period||"GAME"),s=String(m.subject||""),side=String(m.side||"").toLowerCase(),line=finite(m.line);
  const count=`${r.hits} ИЗ ${r.decisions}`;
  const suffix=r.pushes?` · ${r.pushes} ВОЗВР.`:"";
  const per=periodRu(p);
  if(t==="game_total")return `${per}${side==="over"?"ТБ":"ТМ"} ${fmt(line)} — ${count} РЕШЁННЫХ МАТЧЕЙ${suffix}`;
  if(t==="team_total")return `${s} · ${per}${side==="over"?"ИТБ":"ИТМ"} ${fmt(line)} — ${count}${suffix}`;
  if(t==="handicap")return `${s} · ${per}ФОРА ${signed(line)} — ${count}${suffix}`;
  if(t==="moneyline")return side==="draw"?`НИЧЬЯ В ОСНОВНОЕ ВРЕМЯ — ${count} РЕЛЕВАНТНЫХ МАТЧЕЙ`:`${s} ПОБЕДИЛ ${count} МАТЧЕЙ`;
  if(/^period_[123]_result$/.test(t)){
    const n=t.match(/^period_([123])_result$/)?.[1];
    return side==="draw"?`${n}-Й ПЕРИОД ЗАВЕРШИЛСЯ ВНИЧЬЮ В ${count} МАТЧЕЙ`:`${s} ВЫИГРАЛ ${n}-Й ПЕРИОД В ${count} МАТЧЕЙ`;
  }
  if(t==="double_chance")return side==="no_draw"?`БЕЗ НИЧЬЕЙ В ОСНОВНОЕ ВРЕМЯ — ${count} МАТЧЕЙ`:`${s} НЕ ПРОИГРАЛ В ОСНОВНОЕ ВРЕМЯ В ${count} МАТЧЕЙ`;
  if(t==="both_teams_score")return side==="yes"?`ОБЕ КОМАНДЫ ЗАБИВАЛИ В ${count} МАТЧЕЙ`:`ХОТЯ БЫ ОДНА НЕ ЗАБИВАЛА В ${count} МАТЧЕЙ`;
  if(t==="first_goal_team")return `${s} ОТКРЫВАЛ СЧЁТ В ${count} МАТЧЕЙ`;
  if(t==="team_goal_bucket")return `${s}: ${side==="0_1"?"0–1 ШАЙБА":side==="2"?"РОВНО 2 ШАЙБЫ":"3+ ШАЙБЫ"} — ${count} МАТЧЕЙ`;
  if(t==="highest_scoring_period")return `${s||"КОМАНДА"}: ${side.replace("P","")}-Й ПЕРИОД БЫЛ САМЫМ РЕЗУЛЬТАТИВНЫМ В ${count} МАТЧЕЙ`;
  if(t==="win_all_periods")return `${s} ВЫИГРАЛ ВСЕ 3 ПЕРИОДА В ${count} МАТЧЕЙ`;
  if(t==="result_total_combo")return `${s} ПОБЕДИЛ + ${side==="over"?"ТБ":"ТМ"} ${fmt(line)} В ${count} МАТЧЕЙ`;
  return `${marketLabel(m)} — ${count}`;
}
function operatorExplanation(m,r,game){
  const parts=[`Точная текущая линия WINLINE: ${marketLabel(m)} · кэф ${Number(m.odds).toFixed(2)}.`,`Исторический результат: ${r.hits}/${r.decisions} решённых наблюдений (${Math.round(r.rate*100)}%).`];
  if(r.pushes)parts.push(`Возвраты по целой линии: ${r.pushes}.`);
  if(r.away&&r.home)parts.push(`${game.away_tri}: ${r.away.hits}/${r.away.decisions}; ${game.home_tri}: ${r.home.hits}/${r.home.decisions}.`);
  parts.push("Карточка рассчитана непосредственно для этой линии; статистика другой линии не переименовывается.");
  return parts.join(" ");
}

function marketLabel(m){
  const t=String(m.market_type||""),s=String(m.subject||""),side=String(m.side||"").toLowerCase(),line=finite(m.line),p=periodRu(m.period);
  if(t==="game_total")return `${p}${side==="over"?"ТБ":"ТМ"} ${fmt(line)}`;
  if(t==="team_total")return `${s} · ${p}${side==="over"?"ИТБ":"ИТМ"} ${fmt(line)}`;
  if(t==="handicap")return `${s} · ${p}ФОРА ${signed(line)}`;
  if(t==="moneyline")return side==="draw"?"НИЧЬЯ В ОСНОВНОЕ ВРЕМЯ":`ПОБЕДА ${s}`;
  if(/^period_[123]_result$/.test(t))return side==="draw"?`${p}НИЧЬЯ`:`${p}ПОБЕДА ${s}`;
  if(t==="double_chance")return side==="no_draw"?"12 — БЕЗ НИЧЬЕЙ":`${s} ИЛИ НИЧЬЯ`;
  if(t==="both_teams_score")return side==="yes"?"ОБЕ ЗАБЬЮТ — ДА":"ОБЕ ЗАБЬЮТ — НЕТ";
  if(t==="first_goal_team")return `ПЕРВЫЙ ГОЛ — ${s}`;
  if(t==="team_goal_bucket")return `${s} · ${side==="0_1"?"0–1":side==="2"?"РОВНО 2":"3+"} ШАЙБЫ`;
  if(t==="highest_scoring_period")return `${s} · САМЫЙ РЕЗУЛЬТАТИВНЫЙ ${side}`;
  if(t==="win_all_periods")return `${s} · ВЫИГРАЕТ ВСЕ ПЕРИОДЫ`;
  if(t==="result_total_combo")return `ПОБЕДА ${s} + ${side==="over"?"ТБ":"ТМ"} ${fmt(line)}`;
  return [p,t,s,side,line===null?"":fmt(line)].filter(Boolean).join(" ");
}

function periodTotal(row,period){
  if(period==="GAME"||period==="REG")return finite(row.total_goals);
  const p=periodNumber(period);if(!p)return null;
  const gf=finite(row[`p${p}_goals_for`]),ga=finite(row[`p${p}_goals_against`]);
  return gf===null||ga===null?null:gf+ga;
}
function periodGoalsFor(row,period){
  if(period==="GAME")return finite(row.final_goals_for);
  if(period==="REG")return finite(row.regulation_goals_for);
  const p=periodNumber(period);return p?finite(row[`p${p}_goals_for`]):null;
}
function periodGoalDiff(row,period){
  if(period==="GAME")return finite(row.final_goal_diff);
  if(period==="REG")return finite(row.regulation_goal_diff);
  const p=periodNumber(period);if(!p)return null;
  const gf=finite(row[`p${p}_goals_for`]),ga=finite(row[`p${p}_goals_against`]);
  return gf===null||ga===null?null:gf-ga;
}
function settleTotal(total,side,line){
  if(total===line)return "push";
  if(side==="over")return total>line?"win":"loss";
  if(side==="under")return total<line?"win":"loss";
  return null;
}
function settleHandicap(diff,line){
  const x=diff+line;if(x===0)return"push";return x>0?"win":"loss";
}
function periodNumber(period){const m=/^P([123])$/.exec(String(period||""));return m?Number(m[1]):0}
function periodRu(period){const p=periodNumber(period);return p?`${p}-Й ПЕРИОД · `:String(period)==="REG"?"60 МИН · ":""}
function displaySide(m){return String(m.side||"")}
function marketKey(m){const l=finite(m.line);return [m.market_type,m.period,m.subject||"all",displaySide(m),l===null?"none":l.toFixed(2)].join(":")}
function dedupeMarkets(markets){const seen=new Set(),out=[];for(const m of markets){const k=marketKey(m);if(seen.has(k))continue;seen.add(k);out.push(m)}return out}
function finite(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function fmt(v){const n=finite(v);return n===null?"":String(n).replace(".",",")}
function signed(v){const n=finite(v);if(n===null)return"";return(n>0?"+":"")+fmt(n)}
