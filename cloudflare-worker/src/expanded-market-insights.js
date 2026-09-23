
const WINDOWS=[10,20];
const TOTAL_LINES=[4.5,5.5,6.5,7.5];

export async function buildExpandedMarketInsights(db,game){
  if(!db||!game?.scheduled_start_utc||!game?.away_tri||!game?.home_tri)return[];
  const [awayR,homeR]=await db.batch([
    recent(db,game.away_tri,game.scheduled_start_utc),
    recent(db,game.home_tri,game.scheduled_start_utc),
  ]);
  const map=new Map([[game.away_tri,awayR.results||[]],[game.home_tri,homeR.results||[]]]);
  const out=[];
  for(const team of [game.away_tri,game.home_tri]){
    const rows=map.get(team)||[];
    const opponent=team===game.home_tri?game.away_tri:game.home_tri;
    out.push(...teamGoalBucketCards(game,team,rows));
    out.push(...highestScoringPeriodCards(game,team,rows));
    out.push(...winAllPeriodsCards(game,team,rows));
    out.push(...doubleChanceCards(game,team,rows));
    out.push(...resultTotalCards(game,team,rows));
    out.push(...scoreStateCards(game,team,opponent,rows));
  }
  out.push(...bothTeamsScoreCards(game,map.get(game.away_tri)||[],map.get(game.home_tri)||[]));
  return dedupe(out).sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,40);
}

function recent(db,team,before){
  return db.prepare(`
    SELECT game_pk,team_tri,opponent_tri,is_home,
           final_goals_for,final_goals_against,total_goals,final_goal_diff,final_win,
           regulation_result,regulation_goal_diff,
           p1_goals_for,p1_goals_against,p2_goals_for,p2_goals_against,p3_goals_for,p3_goals_against,
           score_after_p1_diff,score_after_p2_diff,first_goal_for
    FROM team_game_features
    WHERE team_tri=? AND scheduled_start_utc<?
    ORDER BY scheduled_start_utc DESC,game_pk DESC
    LIMIT 20;
  `).bind(team,before);
}

function bothTeamsScoreCards(game,awayRows,homeRows){
  const out=[];
  for(const window of WINDOWS){
    const away=awayRows.slice(0,window),home=homeRows.slice(0,window);
    if(away.length<Math.min(8,window)||home.length<Math.min(8,window))continue;
    const pred=r=>Number(r.final_goals_for)>=1&&Number(r.final_goals_against)>=1;
    const ar=count(away,pred)/away.length,hr=count(home,pred)/home.length;
    const avg=(ar+hr)/2;
    for(const side of ["yes","no"]){
      const a=side==="yes"?ar:1-ar,h=side==="yes"?hr:1-hr,effective=(a+h)/2;
      if(a<.55||h<.55||effective<.62)continue;
      const ah=Math.round(a*away.length),hh=Math.round(h*home.length),hits=ah+hh,sample=away.length+home.length;
      out.push(card(game,{
        id:`both-score:${side}:w${window}`,type:"both_teams_score",subject:null,side,line:null,
        score:score(sample,effective,.60),eyebrow:"ОБЕ КОМАНДЫ ЗАБЬЮТ",value:`${hits}/${sample}`,
        title:side==="yes"
          ?`ОБЕ КОМАНДЫ ЗАБИВАЛИ В ${hits} ИЗ ${sample} РЕЛЕВАНТНЫХ МАТЧЕЙ`
          :`ХОТЯ БЫ ОДНА КОМАНДА НЕ ЗАБИВАЛА В ${hits} ИЗ ${sample} РЕЛЕВАНТНЫХ МАТЧЕЙ`,
        explanation:`${game.away_tri}: ${ah}/${away.length}; ${game.home_tri}: ${hh}/${home.length}. Два независимых командных среза для точного рынка «обе забьют».`,
        evidence:{window,sample,hits,hit_rate:effective,away:{hits:ah,sample:away.length,hit_rate:a},home:{hits:hh,sample:home.length,hit_rate:h},role:side==="yes"?"both_teams_score_yes":"both_teams_score_no",game_pks:[...away,...home].map(x=>Number(x.game_pk))}
      }));
    }
  }
  return out;
}

function teamGoalBucketCards(game,team,rows){
  const out=[];
  for(const window of WINDOWS){
    const s=rows.slice(0,window);if(s.length<Math.min(8,window))continue;
    const defs=[
      ["0_1",r=>Number(r.final_goals_for)<=1,"0–1 ШАЙБА"],
      ["2",r=>Number(r.final_goals_for)===2,"РОВНО 2 ШАЙБЫ"],
      ["3_plus",r=>Number(r.final_goals_for)>=3,"3+ ШАЙБЫ"],
    ];
    for(const [side,pred,label] of defs){
      const h=count(s,pred),rate=h/s.length;
      if(rate<0.55)continue;
      out.push(card(game,{
        id:`goal-bucket:${team}:${side}:w${window}`,type:"team_goal_bucket",subject:team,side,line:null,
        score:score(window,rate,.55),eyebrow:`ГОЛЫ ${team} · ${window} МАТЧЕЙ`,value:`${h}/${s.length}`,
        title:`${team}: ${label} В ${h} ИЗ ПОСЛЕДНИХ ${s.length} МАТЧЕЙ`,
        explanation:`Распределение итоговых голов ${team}; точная частота для дискретного рынка количества шайб.`,
        evidence:{window,sample:s.length,hits:h,hit_rate:rate,team,role:"team_goal_bucket",game_pks:s.map(x=>Number(x.game_pk))}
      }));
    }
  }
  return out;
}

function highestScoringPeriodCards(game,team,rows){
  const out=[];
  for(const window of WINDOWS){
    const s=rows.slice(0,window);if(s.length<Math.min(8,window))continue;
    for(const p of [1,2,3]){
      const h=count(s,r=>{
        const vals=[1,2,3].map(n=>Number(r[`p${n}_goals_for`]||0));
        const mx=Math.max(...vals);return mx>0&&vals[p-1]===mx&&vals.filter(x=>x===mx).length===1;
      });
      const rate=h/s.length;if(rate<.40)continue;
      out.push(card(game,{
        id:`highest-period:${team}:p${p}:w${window}`,type:"highest_scoring_period",subject:team,side:`P${p}`,line:null,
        score:score(window,rate,.35),eyebrow:"САМЫЙ РЕЗУЛЬТАТИВНЫЙ ПЕРИОД",value:`${h}/${s.length}`,
        title:`${p}-Й ПЕРИОД — САМЫЙ РЕЗУЛЬТАТИВНЫЙ ДЛЯ ${team} В ${h} ИЗ ${s.length} МАТЧЕЙ`,
        explanation:"Учитываются только матчи, где один период был единолично самым результативным для команды.",
        evidence:{window,sample:s.length,hits:h,hit_rate:rate,team,period:p,role:"highest_scoring_period",game_pks:s.map(x=>Number(x.game_pk))}
      }));
    }
  }
  return out;
}

function winAllPeriodsCards(game,team,rows){
  const s=rows.slice(0,20);if(s.length<12)return[];
  const h=count(s,r=>[1,2,3].every(p=>Number(r[`p${p}_goals_for`]||0)>Number(r[`p${p}_goals_against`]||0)));
  const rate=h/s.length;if(rate<.20)return[];
  return [card(game,{
    id:`win-all-periods:${team}`,type:"win_all_periods",subject:team,side:team,line:null,
    score:Math.min(90,70+Math.round(rate*50)),eyebrow:"ВЫИГРАТЬ ВСЕ ПЕРИОДЫ",value:`${h}/${s.length}`,
    title:`${team} ВЫИГРАЛ ВСЕ 3 ПЕРИОДА В ${h} ИЗ ПОСЛЕДНИХ ${s.length} МАТЧЕЙ`,
    explanation:"Редкий рынок: карточка создаётся только на 12+ матчах и при заметной фактической частоте.",
    evidence:{sample:s.length,hits:h,hit_rate:rate,team,role:"win_all_periods",game_pks:s.map(x=>Number(x.game_pk))}
  })];
}

function doubleChanceCards(game,team,rows){
  const out=[];
  for(const window of WINDOWS){
    const s=rows.slice(0,window);if(s.length<Math.min(8,window))continue;
    const h=count(s,r=>String(r.regulation_result)!=="L"),rate=h/s.length;
    if(rate<.70)continue;
    out.push(card(game,{
      id:`double-chance:${team}:w${window}`,type:"double_chance",subject:team,side:"team_or_draw",line:null,
      score:score(window,rate,.70),eyebrow:"НЕ ПРОИГРАТЬ В ОСНОВНОЕ ВРЕМЯ",value:`${h}/${s.length}`,
      title:`${team} НЕ ПРОИГРАЛ В ОСНОВНОЕ ВРЕМЯ В ${h} ИЗ ${s.length} МАТЧЕЙ`,
      explanation:"W/T в основное время; овертайм и буллиты не превращаются в победу/поражение этого рынка.",
      evidence:{window,sample:s.length,hits:h,hit_rate:rate,team,role:"regulation_non_loss",game_pks:s.map(x=>Number(x.game_pk))}
    }));
  }
  return out;
}

function resultTotalCards(game,team,rows){
  const out=[];
  for(const window of WINDOWS){
    const s=rows.slice(0,window);if(s.length<Math.min(8,window))continue;
    for(const line of TOTAL_LINES){
      for(const side of ["over","under"]){
        const pred=r=>Number(r.final_win)===1&&(side==="over"?Number(r.total_goals)>line:Number(r.total_goals)<line);
        const h=count(s,pred),rate=h/s.length;
        if(rate<.45)continue;
        out.push(card(game,{
          id:`result-total:${team}:${side}:${line}:w${window}`,type:"result_total_combo",subject:team,side,line,
          score:score(window,rate,.42),eyebrow:"ПОБЕДА + ТОТАЛ",value:`${h}/${s.length}`,
          title:`${team} ПОБЕДИЛ + ${side==="over"?"ТБ":"ТМ"} ${fmt(line)} В ${h} ИЗ ${s.length} МАТЧЕЙ`,
          explanation:"Комбинированный рынок появляется только по фактическому совместному исходу; один и тот же факт не дублируется дважды.",
          evidence:{window,sample:s.length,hits:h,hit_rate:rate,team,role:"result_total_combo",total_line:line,total_side:side,game_pks:s.map(x=>Number(x.game_pk))}
        }));
      }
    }
  }
  return out;
}

function scoreStateCards(game,team,opponent,rows){
  const s=rows.slice(0,20);if(s.length<12)return[];
  const trailingAfterP2=s.filter(r=>Number(r.score_after_p2_diff)<0);
  const leadingAfterP2=s.filter(r=>Number(r.score_after_p2_diff)>0);
  const out=[];
  if(trailingAfterP2.length>=4){
    const h=count(trailingAfterP2,r=>Number(r.final_win)===1),rate=h/trailingAfterP2.length;
    if(rate>=.35)out.push(contextCard(game,team,opponent,"comeback",rate,h,trailingAfterP2.length));
  }
  if(leadingAfterP2.length>=4){
    const h=count(leadingAfterP2,r=>Number(r.final_win)===1),rate=h/leadingAfterP2.length;
    if(rate>=.70)out.push(contextCard(game,team,opponent,"protect",rate,h,leadingAfterP2.length));
  }
  return out;
}
function contextCard(game,team,opponent,kind,rate,hits,sample){
  const comeback=kind==="comeback";
  return {
    id:`${game.game_pk}:score-state:${team}:${kind}`,insight_type:`score_state_${kind}`,category:"score_state",
    kind:"history",timing:"pregame",score:Math.min(92,72+Math.round(rate*20)),eyebrow:comeback?"КАМБЭКИ":"УДЕРЖАНИЕ ЛИДЕРСТВА",value:`${hits}/${sample}`,
    title:comeback?`${team} ОТЫГРАЛСЯ ПОСЛЕ ОТСТАВАНИЯ К 3-МУ ПЕРИОДУ В ${hits} ИЗ ${sample}`:`${team} УДЕРЖАЛ ПОБЕДУ ПОСЛЕ ЛИДЕРСТВА К 3-МУ ПЕРИОДУ В ${hits} ИЗ ${sample}`,
    explanation:comeback?"История матчей, где команда уступала после двух периодов.":"История матчей, где команда вела после двух периодов.",
    evidence:{sample,hits,hit_rate:rate,team,opponent,role:comeback?"comeback_after_p2":"protect_lead_after_p2",feature_layer:"team_game_features_score_state_v1"},
    market:{type:"moneyline",period:"GAME",subject:team,side:team,line:null,label:`Победа ${team}`}
  };
}

function card(game,x){
  return {id:`${game.game_pk}:expanded:${x.id}`,insight_type:x.type,category:"expanded_market",kind:"history",timing:"pregame",
    score:Math.round(x.score),eyebrow:x.eyebrow,value:x.value,title:x.title,explanation:x.explanation,
    evidence:{...x.evidence,feature_layer:"team_game_features_expanded_markets_v1"},
    market:{type:x.type,period:"GAME",subject:x.subject,side:x.side,line:x.line,label:marketLabel(x)}};
}
function marketLabel(x){
  if(x.type==="both_teams_score")return x.side==="yes"?"Обе команды забьют":"Обе команды забьют — нет";
  if(x.type==="team_goal_bucket")return `${x.subject}: ${x.side==="0_1"?"0–1":x.side==="2"?"ровно 2":"3+"} шайбы`;
  if(x.type==="highest_scoring_period")return `${x.subject}: самый результативный ${x.side}`;
  if(x.type==="win_all_periods")return `${x.subject}: выиграет все периоды`;
  if(x.type==="double_chance")return `${x.subject} не проиграет в основное время`;
  if(x.type==="result_total_combo")return `Победа ${x.subject} + ${x.side==="over"?"ТБ":"ТМ"} ${fmt(x.line)}`;
  return x.type;
}
function score(window,rate,floor){return Math.min(96,72+(window===20?7:4)+Math.round(Math.max(0,rate-floor)*35))}
function count(rows,p){return rows.reduce((n,r)=>n+(p(r)?1:0),0)}
function fmt(v){return String(v).replace(".",",")}
function dedupe(cards){const s=new Set();return cards.filter(c=>{const k=[c.market?.type,c.market?.subject,c.market?.side,c.market?.line,c.evidence?.window].join(":");if(s.has(k))return false;s.add(k);return true})}
