
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
    const pace=(away.pim_pg+home.pim_pg)/2+(away.ppg_pg+home.ppg_pg)*4;
    if(pace>=8)out.push(gameCard(game,"over",Math.min(94,72+Math.round((pace-8)*4)),away,home));
    if(pace<=4.5)out.push(gameCard(game,"under",Math.min(90,76+Math.round((4.5-pace)*5)),away,home));
  }
  return out.sort((x,y)=>y.score-x.score).slice(0,8);
}

function recent(db,team,before){
  return db.prepare("SELECT game_pk,team_tri,opponent_tri,power_play_goals_for,power_play_goals_against,pim_for,pim_against,final_goals_for,final_goals_against FROM team_game_features WHERE team_tri=? AND scheduled_start_utc<? ORDER BY scheduled_start_utc DESC,game_pk DESC LIMIT 20;").bind(team,before);
}
function summary(rows){
  const s=(rows||[]).slice(0,10);if(s.length<8)return null;
  return {sample:s.length,ppg_pg:avg(s,"power_play_goals_for"),ppga_pg:avg(s,"power_play_goals_against"),pim_pg:avg(s,"pim_for"),opp_pim_pg:avg(s,"pim_against"),gf_pg:avg(s,"final_goals_for"),ga_pg:avg(s,"final_goals_against"),game_pks:s.map(x=>Number(x.game_pk))};
}
function overStrength(a,b){
  let s=58;
  if(a.ppg_pg>=.7)s+=12;else if(a.ppg_pg>=.45)s+=7;
  if(b.ppga_pg>=.7)s+=12;else if(b.ppga_pg>=.45)s+=7;
  if(b.pim_pg>=9)s+=8;else if(b.pim_pg>=7)s+=4;
  if(a.gf_pg>=3.2)s+=5;
  return Math.min(96,s);
}
function underStrength(a,b){
  let s=55;
  if(a.ppg_pg<=.2)s+=11;else if(a.ppg_pg<=.3)s+=6;
  if(b.ppga_pg<=.2)s+=11;else if(b.ppga_pg<=.3)s+=6;
  if(b.pim_pg<=5)s+=7;
  if(a.gf_pg<=2.5)s+=6;
  return Math.min(92,s);
}
function card(game,team,opponent,side,score,a,b){
  const over=side==="over",id=String(game.game_pk)+":special:"+team+":"+side;
  return {id,insight_type:"special_teams_"+side,category:"special_teams",kind:"history",timing:"pregame",score,
    eyebrow:"СПЕЦБРИГАДЫ · ПОСЛЕДНИЕ 10",value:a.ppg_pg.toFixed(2)+" PPG/матч",
    title:over?team+" регулярно забивает в большинстве, а "+opponent+" часто пропускает в меньшинстве":team+" редко забивает в большинстве, а "+opponent+" мало пропускает в меньшинстве",
    explanation:"Контекст спецбригад использует голы в большинстве, голы против большинства и штрафные минуты. Без стабильного denominator по попыткам большинства это подтверждающий, а не основной вероятностный сигнал.",
    evidence:{sample:a.sample,team,opponent,role:over?"special_teams_over":"special_teams_under",pp_goals_pg:a.ppg_pg,opponent_pp_goals_allowed_pg:b.ppga_pg,opponent_pim_pg:b.pim_pg,game_pks:a.game_pks,feature_layer:"team_game_features_special_teams_v1"},
    market:{type:"team_total",period:"GAME",subject:team,side,line:2.5,label:team+" "+(over?"ИТБ":"ИТМ")+" 2.5"}};
}
function gameCard(game,side,score,a,h){
  const over=side==="over";
  return {id:String(game.game_pk)+":special:game:"+side,insight_type:"special_teams_game_"+side,category:"special_teams",kind:"history",timing:"pregame",score,
    eyebrow:"СПЕЦБРИГАДЫ · ТЕМП",value:(a.pim_pg+h.pim_pg).toFixed(1)+" PIM/матч",
    title:over?"Матчап создаёт повышенный потенциал голов в спецбригадах":"Матчап даёт мало оснований ждать много голов в спецбригадах",
    explanation:"Сигнал объединяет штрафные минуты и голы в большинстве обеих команд за последние 10 матчей. Используется только как независимый слой к общему тоталу.",
    evidence:{sample:Math.min(a.sample,h.sample),role:over?"special_teams_over":"special_teams_under",away_pp_goals_pg:a.ppg_pg,home_pp_goals_pg:h.ppg_pg,away_pim_pg:a.pim_pg,home_pim_pg:h.pim_pg,feature_layer:"team_game_features_special_teams_v1"},
    market:{type:"game_total",period:"GAME",subject:null,side,line:5.5,label:(over?"ТБ":"ТМ")+" 5.5"}};
}
function avg(rows,key){const xs=rows.map(r=>Number(r[key])).filter(Number.isFinite);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0}
