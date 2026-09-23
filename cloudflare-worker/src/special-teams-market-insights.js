
export async function buildSpecialTeamsMarketInsights(db,game){
  if(!db||!game?.scheduled_start_utc||!game?.away_tri||!game?.home_tri)return[];
  const [a,h]=await db.batch([
    recent(db,game.away_tri,game.scheduled_start_utc),
    recent(db,game.home_tri,game.scheduled_start_utc)
  ]);
  const rows=new Map([[game.away_tri,a.results||[]],[game.home_tri,h.results||[]]]),out=[];
  for(const team of [game.away_tri,game.home_tri]){
    const opponent=team===game.home_tri?game.away_tri:game.home_tri;
    const own=summary(rows.get(team)||[]),opp=summary(rows.get(opponent)||[]);
    if(!own||!opp)continue;
    const overScore=overStrength(own,opp),underScore=underStrength(own,opp);
    if(overScore>=72)out.push(card(game,team,opponent,"over",overScore,own,opp));
    if(underScore>=76)out.push(card(game,team,opponent,"under",underScore,own,opp));
  }
  const away=summary(rows.get(game.away_tri)||[]),home=summary(rows.get(game.home_tri)||[]);
  if(away&&home){
    const specialGoalRate=away.ppg_pg+home.ppg_pg;
    const ppOpportunityRate=away.ppo_pg+home.ppo_pg;
    const penaltyPace=(away.pim_pg+home.pim_pg)/2;
    const pace=penaltyPace+specialGoalRate*4+Math.max(0,ppOpportunityRate-5)*0.6;
    if(pace>=8)out.push(gameCard(game,"over",Math.min(94,72+Math.round((pace-8)*4)),away,home));
    if(pace<=4.5)out.push(gameCard(game,"under",Math.min(90,76+Math.round((4.5-pace)*5)),away,home));
  }
  return out.sort((x,y)=>y.score-x.score).slice(0,10);
}

function recent(db,team,before){
  return db.prepare(`
    SELECT
      f.game_pk,f.team_tri,f.opponent_tri,
      f.power_play_goals_for,f.power_play_goals_against,
      f.pim_for,f.pim_against,f.final_goals_for,f.final_goals_against,
      own.power_play_goals AS own_pp_goals,
      own.power_play_opportunities AS own_pp_opportunities,
      opp.power_play_goals AS opp_pp_goals,
      opp.power_play_opportunities AS opp_pp_opportunities
    FROM team_game_features f
    LEFT JOIN team_game_stats own
      ON own.game_pk=f.game_pk AND own.team_tri=f.team_tri
    LEFT JOIN team_game_stats opp
      ON opp.game_pk=f.game_pk AND opp.team_tri=f.opponent_tri
    WHERE f.team_tri=? AND f.scheduled_start_utc<?
    ORDER BY f.scheduled_start_utc DESC,f.game_pk DESC
    LIMIT 20;
  `).bind(team,before);
}

function summary(rows){
  const s=(rows||[]).slice(0,10);if(s.length<8)return null;
  const ownPpo=sumFinite(s,"own_pp_opportunities"),ownPpg=sumFinite(s,"own_pp_goals");
  const oppPpo=sumFinite(s,"opp_pp_opportunities"),oppPpg=sumFinite(s,"opp_pp_goals");
  const ppPct=ownPpo>=10?ownPpg/ownPpo:null;
  const pkPct=oppPpo>=10?1-(oppPpg/oppPpo):null;
  return {
    sample:s.length,
    ppg_pg:avg(s,"power_play_goals_for"),
    ppga_pg:avg(s,"power_play_goals_against"),
    ppo_pg:ownPpo/s.length,
    pp_pct:ppPct,
    pk_pct:pkPct,
    pp_goals:ownPpg,
    pp_opportunities:ownPpo,
    pk_goals_allowed:oppPpg,
    pk_opportunities:oppPpo,
    pim_pg:avg(s,"pim_for"),
    opp_pim_pg:avg(s,"pim_against"),
    gf_pg:avg(s,"final_goals_for"),
    ga_pg:avg(s,"final_goals_against"),
    game_pks:s.map(x=>Number(x.game_pk))
  };
}
function overStrength(a,b){
  let s=56;
  if(a.pp_pct!==null){
    if(a.pp_pct>=.28)s+=16;else if(a.pp_pct>=.23)s+=11;else if(a.pp_pct>=.20)s+=6;
  }else if(a.ppg_pg>=.7)s+=12;else if(a.ppg_pg>=.45)s+=7;
  if(b.pk_pct!==null){
    if(b.pk_pct<=.72)s+=16;else if(b.pk_pct<=.77)s+=11;else if(b.pk_pct<=.80)s+=6;
  }else if(b.ppga_pg>=.7)s+=12;else if(b.ppga_pg>=.45)s+=7;
  if(b.pim_pg>=9)s+=8;else if(b.pim_pg>=7)s+=4;
  if(a.ppo_pg>=3.5)s+=4;
  if(a.gf_pg>=3.2)s+=4;
  return Math.min(97,s);
}
function underStrength(a,b){
  let s=54;
  if(a.pp_pct!==null){
    if(a.pp_pct<=.12)s+=15;else if(a.pp_pct<=.16)s+=10;else if(a.pp_pct<=.19)s+=5;
  }else if(a.ppg_pg<=.2)s+=10;else if(a.ppg_pg<=.3)s+=6;
  if(b.pk_pct!==null){
    if(b.pk_pct>=.88)s+=15;else if(b.pk_pct>=.84)s+=10;else if(b.pk_pct>=.81)s+=5;
  }else if(b.ppga_pg<=.2)s+=10;else if(b.ppga_pg<=.3)s+=6;
  if(b.pim_pg<=5)s+=7;
  if(a.ppo_pg<=2.2)s+=4;
  if(a.gf_pg<=2.5)s+=5;
  return Math.min(94,s);
}
function card(game,team,opponent,side,score,a,b){
  const over=side==="over",id=String(game.game_pk)+":special:"+team+":"+side;
  const pp=a.pp_pct===null?null:Math.round(a.pp_pct*100);
  const oppPk=b.pk_pct===null?null:Math.round(b.pk_pct*100);
  const value=pp!==null?pp+"%":a.ppg_pg.toFixed(2)+" гола/матч";
  const title=pp!==null
    ? team+" — "+pp+"% В БОЛЬШИНСТВЕ ЗА 10 МАТЧЕЙ"
    : team+" — "+a.ppg_pg.toFixed(2)+" ГОЛА В БОЛЬШИНСТВЕ ЗА МАТЧ";
  const detail=[
    pp!==null?team+": "+a.pp_goals+"/"+a.pp_opportunities+" реализаций большинства ("+pp+"%).":null,
    oppPk!==null?opponent+": "+oppPk+"% нейтрализации меньшинства ("+b.pk_goals_allowed+" пропущенных в "+b.pk_opportunities+" меньшинствах).":null,
    opponent+": "+b.pim_pg.toFixed(1)+" штрафных минут за матч на отрезке."
  ].filter(Boolean).join(" ");
  return {id,insight_type:"special_teams_"+side,category:"special_teams",kind:"history",timing:"pregame",score,
    eyebrow:"СПЕЦБРИГАДЫ · ПОСЛЕДНИЕ 10",value,title,
    explanation:detail+" Спецбригады — поддерживающий слой к командному тоталу, а не самостоятельная вероятность.",
    evidence:{sample:a.sample,team,opponent,role:over?"special_teams_over":"special_teams_under",
      pp_goals_pg:a.ppg_pg,pp_pct:a.pp_pct,pp_goals:a.pp_goals,pp_opportunities:a.pp_opportunities,
      opponent_pk_pct:b.pk_pct,opponent_pk_goals_allowed:b.pk_goals_allowed,opponent_pk_opportunities:b.pk_opportunities,
      opponent_pp_goals_allowed_pg:b.ppga_pg,opponent_pim_pg:b.pim_pg,game_pks:a.game_pks,
      feature_layer:"team_game_stats_special_teams_v2"},
    market:{type:"team_total",period:"GAME",subject:team,side,line:2.5,label:team+" "+(over?"ИТБ":"ИТМ")+" 2.5"}};
}
function gameCard(game,side,score,a,h){
  const over=side==="over";
  const ppValues=[a.pp_pct,h.pp_pct].filter(x=>x!==null);
  const avgPp=ppValues.length?ppValues.reduce((x,y)=>x+y,0)/ppValues.length:null;
  return {id:String(game.game_pk)+":special:game:"+side,insight_type:"special_teams_game_"+side,category:"special_teams",kind:"history",timing:"pregame",score,
    eyebrow:"СПЕЦБРИГАДЫ · ТЕМП",value:avgPp!==null?Math.round(avgPp*100)+"% ср. PP":(a.pim_pg+h.pim_pg).toFixed(1)+" PIM/матч",
    title:over
      ?"ОБЕ КОМАНДЫ СОЗДАЮТ ВЫСОКИЙ ПОТЕНЦИАЛ ГОЛОВ В СПЕЦБРИГАДАХ"
      :"МАТЧАП ДАЁТ МАЛО ГОЛЕВОГО ДАВЛЕНИЯ В СПЕЦБРИГАДАХ",
    explanation:"Последние 10 матчей каждой команды: учитываются реальные попытки большинства, реализация, качество меньшинства и штрафные минуты. Слой используется как независимое подтверждение общего тотала.",
    evidence:{sample:Math.min(a.sample,h.sample),role:over?"special_teams_over":"special_teams_under",
      away_pp_pct:a.pp_pct,home_pp_pct:h.pp_pct,away_pk_pct:a.pk_pct,home_pk_pct:h.pk_pct,
      away_pp_opportunities:a.pp_opportunities,home_pp_opportunities:h.pp_opportunities,
      away_pim_pg:a.pim_pg,home_pim_pg:h.pim_pg,feature_layer:"team_game_stats_special_teams_v2"},
    market:{type:"game_total",period:"GAME",subject:null,side,line:5.5,label:(over?"ТБ":"ТМ")+" 5.5"}};
}
function avg(rows,key){const xs=rows.map(r=>Number(r[key])).filter(Number.isFinite);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0}
function sumFinite(rows,key){return rows.reduce((n,r)=>{const v=Number(r[key]);return n+(Number.isFinite(v)?v:0)},0)}
