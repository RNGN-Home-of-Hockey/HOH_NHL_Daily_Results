import snapshot from "../../data/advanced_team_snapshot_2024_2026.json" with { type: "json" };

const TEAM_TOTAL_LINES=[1.5,2.5,3.5,4.5];
const GAME_TOTAL_LINES=[4.5,5.5,6.5,7.5];
const HANDICAP_LINES=[-2.5,-1.5,1.5,2.5];

export function buildAdvancedTeamSnapshotInsights(game){
  const away=up(game?.away_tri),home=up(game?.home_tri);
  if(!snapshot?.teams?.[away]||!snapshot?.teams?.[home])return[];
  const out=[];
  out.push(...teamMarketCards(game,away,home));
  out.push(...teamMarketCards(game,home,away));
  out.push(...gameTotalCards(game,away,home));
  return out;
}

export function advancedMetricRank(team,profile,metric,direction="desc"){
  const rows=Object.entries(snapshot?.teams||{})
    .map(([tri,row])=>({tri,value:num(row?.[profile]?.[metric])}))
    .filter(x=>Number.isFinite(x.value))
    .sort((a,b)=>direction==="asc"?a.value-b.value:b.value-a.value||a.tri.localeCompare(b.tri));
  const i=rows.findIndex(x=>x.tri===up(team));
  return i<0?null:i+1;
}

function teamMarketCards(game,team,opponent){
  const out=[];
  const over=bestTeamTotalSignal(team,opponent,"over");
  const under=bestTeamTotalSignal(team,opponent,"under");
  if(over)for(const line of TEAM_TOTAL_LINES)out.push(card(game,over,{
    type:"team_total",period:"GAME",subject:team,side:"over",line,label:`${team} ИТБ ${line}`
  },`advanced_team_total_over_${team}_${key(line)}`));
  if(under)for(const line of TEAM_TOTAL_LINES)out.push(card(game,under,{
    type:"team_total",period:"GAME",subject:team,side:"under",line,label:`${team} ИТМ ${line}`
  },`advanced_team_total_under_${team}_${key(line)}`));

  const dominance=bestDominanceSignal(team,opponent);
  if(dominance){
    out.push(card(game,dominance,{
      type:"moneyline",period:"GAME",subject:team,side:team,line:null,label:`Победа ${team}`
    },`advanced_moneyline_${team}`));
    for(const line of HANDICAP_LINES)out.push(card(game,dominance,{
      type:"handicap",period:"GAME",subject:team,side:team,line,label:`${team} ${signed(line)}`
    },`advanced_handicap_${team}_${key(line)}`));
  }
  return out;
}

function bestTeamTotalSignal(team,opponent,side){
  const candidates=[];
  if(side==="over"){
    candidates.push(rankSignal(team,"s","sf60","desc",6,"БРОСКАМ",v=>`${fmt(v,1)} броска/60`));
    candidates.push(rankSignal(team,"s","xgf60","desc",6,"xG/60",v=>`${fmt(v,2)} xG/60`));
    candidates.push(rankSignal(team,"s","hdxgf60","desc",6,"ОПАСНОМУ xG",v=>`${fmt(v,2)} HD xG/60`));
    candidates.push(rankSignal(team,"pp","xgf60","desc",5,"xG В БОЛЬШИНСТВЕ",v=>`${fmt(v,2)} xG/60 в большинстве`));
    candidates.push(defenseWeaknessSignal(opponent,"sa60","ДОПУЩЕННЫМ БРОСКАМ","броска/60"));
    candidates.push(defenseWeaknessSignal(opponent,"xga60","ДОПУЩЕННОМУ xG","xGA/60"));
    candidates.push(defenseWeaknessSignal(opponent,"hdxga60","ДОПУЩЕННОМУ ОПАСНОМУ xG","HD xGA/60"));
  }else{
    candidates.push(bottomAttackSignal(team,"sf60","БРОСКАМ","броска/60"));
    candidates.push(bottomAttackSignal(team,"xgf60","xG/60","xG/60"));
    candidates.push(eliteDefenseSignal(opponent,"sa60","ДОПУЩЕННЫМ БРОСКАМ","броска/60"));
    candidates.push(eliteDefenseSignal(opponent,"xga60","ДОПУЩЕННОМУ xG","xGA/60"));
    candidates.push(eliteDefenseSignal(opponent,"hdxga60","ДОПУЩЕННОМУ ОПАСНОМУ xG","HD xGA/60"));
  }
  return best(candidates);
}

function bestDominanceSignal(team,opponent){
  const candidates=[
    matchupRankSignal(team,opponent,"xgd60","xG-ДИФФЕРЕНЦИАЛУ",v=>signedValue(v,2)+" xG/60"),
    matchupRankSignal(team,opponent,"sd60","РАЗНИЦЕ БРОСКОВ",v=>signedValue(v,1)+" броска/60"),
    matchupRankSignal(team,opponent,"xgf_pct","ДОЛЕ xG",v=>fmt(v,1)+"%"),
    matchupRankSignal(team,opponent,"cf_pct","CORSI",v=>fmt(v,1)+"%"),
  ];
  return best(candidates);
}

function gameTotalCards(game,away,home){
  const out=[];
  const over=paceSignal(away,home,"over");
  const under=paceSignal(away,home,"under");
  if(over)for(const line of GAME_TOTAL_LINES)out.push(card(game,over,{
    type:"game_total",period:"GAME",subject:null,side:"over",line,label:`ТБ ${line}`
  },`advanced_game_total_over_${key(line)}`));
  if(under)for(const line of GAME_TOTAL_LINES)out.push(card(game,under,{
    type:"game_total",period:"GAME",subject:null,side:"under",line,label:`ТМ ${line}`
  },`advanced_game_total_under_${key(line)}`));
  return out;
}

function paceSignal(a,b,side){
  const metrics=[
    {key:"xgpace60",label:"xG-ТЕМПУ",unit:"xG/60"},
    {key:"shotpace60",label:"ТЕМПУ БРОСКОВ",unit:"броска/60"},
  ];
  const candidates=[];
  for(const m of metrics){
    const ra=advancedMetricRank(a,"s",m.key,side==="over"?"desc":"asc");
    const rb=advancedMetricRank(b,"s",m.key,side==="over"?"desc":"asc");
    if(!ra||!rb)continue;
    const va=value(a,"s",m.key),vb=value(b,"s",m.key);
    const strong=side==="over"?(ra<=10&&rb<=10):(ra<=10&&rb<=10);
    if(!strong)continue;
    const score=80+Math.max(0,10-Math.round((ra+rb)/2));
    candidates.push({
      score,
      title:`${a} — №${ra}, ${b} — №${rb} НХЛ ПО ${m.label}`,
      explanation:`Сезон 2025/26: ${a} ${fmt(va,1)} ${m.unit}, ${b} ${fmt(vb,1)} ${m.unit}. Это контекст темпа для линии общего тотала, а не вероятность прохода.`,
      evidence:{sample:82,season:"20252026",metric:m.key,away_rank:ra,home_rank:rb,away_value:va,home_value:vb,advanced_snapshot:true}
    });
  }
  return best(candidates);
}

function rankSignal(team,profile,metric,direction,maxRank,label,format){
  const rank=advancedMetricRank(team,profile,metric,direction);
  if(!rank||rank>maxRank)return null;
  const v=value(team,profile,metric);
  const persistent=persistentTop(team,metric,8);
  return {
    score:84+(maxRank-rank)+persistent,
    title:`${team} — №${rank} НХЛ ПО ${label} В 2025/26`,
    explanation:`${format(v)}. Лиговый ранг рассчитан по полному сезону 2025/26.${persistent?" Сильный профиль сохранялся и в 2024/25.":""}`,
    evidence:{sample:82,season:"20252026",team,metric,rank,value:v,persistent_previous_season:Boolean(persistent),advanced_snapshot:true}
  };
}

function defenseWeaknessSignal(team,metric,label,unit){
  const rank=advancedMetricRank(team,"s",metric,"asc");
  if(!rank||rank<27)return null;
  const v=value(team,"s",metric);
  return {
    score:80+(rank-26),
    title:`${team} — ${rank}-Й В НХЛ ПО ${label} В 2025/26`,
    explanation:`${fmt(v,metric.includes("60")?2:1)} ${unit}. Чем выше место здесь, тем лучше защита; ${rank}-е место — нижняя часть лиги.`,
    evidence:{sample:82,season:"20252026",team,metric,rank,value:v,role:"opponent_weakness",advanced_snapshot:true}
  };
}
function bottomAttackSignal(team,metric,label,unit){
  const rank=advancedMetricRank(team,"s",metric,"desc");
  if(!rank||rank<27)return null;
  const v=value(team,"s",metric);
  return {
    score:79+(rank-26),
    title:`${team} — ${rank}-Й В НХЛ ПО ${label} В 2025/26`,
    explanation:`${fmt(v,2)} ${unit}. Низкий сезонный объём атаки используется как контекст для индивидуального тотала меньше.`,
    evidence:{sample:82,season:"20252026",team,metric,rank,value:v,role:"weak_attack",advanced_snapshot:true}
  };
}
function eliteDefenseSignal(team,metric,label,unit){
  const rank=advancedMetricRank(team,"s",metric,"asc");
  if(!rank||rank>6)return null;
  const v=value(team,"s",metric);
  return {
    score:84+(6-rank),
    title:`${team} — №${rank} НХЛ ПО ${label} В 2025/26`,
    explanation:`${fmt(v,2)} ${unit}. Низкое значение — сильный оборонительный профиль.`,
    evidence:{sample:82,season:"20252026",team,metric,rank,value:v,role:"elite_defense",advanced_snapshot:true}
  };
}
function matchupRankSignal(team,opponent,metric,label,format){
  const rt=advancedMetricRank(team,"s",metric,"desc");
  const ro=advancedMetricRank(opponent,"s",metric,"desc");
  if(!rt||!ro||rt>8)return null;
  const gap=ro-rt;
  if(gap<10)return null;
  const v=value(team,"s",metric),ov=value(opponent,"s",metric);
  const persistent=persistentTop(team,metric,8);
  return {
    score:84+Math.min(8,Math.floor(gap/3))+persistent,
    title:`${team} — №${rt} НХЛ ПО ${label}; ${opponent} — ${ro}-Й`,
    explanation:`2025/26: ${team} ${format(v)}, ${opponent} ${format(ov)}. Разница в лиговом ранге — ${gap} мест.${persistent?" Профиль устойчив два сезона.":""}`,
    evidence:{sample:82,season:"20252026",team,opponent,metric,team_rank:rt,opponent_rank:ro,rank_gap:gap,team_value:v,opponent_value:ov,persistent_previous_season:Boolean(persistent),advanced_snapshot:true}
  };
}
function persistentTop(team,metric,maxRank){
  if(!snapshot?.teams?.[team]?.p||snapshot.teams[team].p[metric]===undefined)return 0;
  const rows=Object.entries(snapshot.teams).map(([tri,row])=>({tri,value:num(row?.p?.[metric])})).filter(x=>Number.isFinite(x.value)).sort((a,b)=>b.value-a.value||a.tri.localeCompare(b.tri));
  const i=rows.findIndex(x=>x.tri===team);
  return i>=0&&i+1<=maxRank?4:0;
}
function card(game,signal,market,suffix){
  return {
    id:`${game.game_pk}:advanced-snapshot:${suffix}`,
    insight_type:suffix,
    category:"advanced_market",
    kind:"history",
    timing:"pregame",
    score:Math.max(0,Math.min(99,Math.round(signal.score))),
    eyebrow:"ADVANCED · СЕЗОННЫЙ ПРОФИЛЬ",
    value:signal.title,
    title:signal.title,
    explanation:signal.explanation,
    evidence:{...signal.evidence,source:"user_supplied_advanced_team_csv"},
    market
  };
}
function best(rows){return(rows||[]).filter(Boolean).sort((a,b)=>b.score-a.score)[0]||null}
function value(team,profile,metric){return num(snapshot?.teams?.[team]?.[profile]?.[metric])}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function up(v){return String(v||"").trim().toUpperCase()}
function fmt(v,d=1){const n=Number(v);return Number.isFinite(n)?n.toFixed(d).replace(".",","):"—"}
function signedValue(v,d=1){const n=Number(v);return Number.isFinite(n)?(n>0?"+":"")+fmt(n,d):"—"}
function key(v){return String(v).replace("-","m").replace(".","_")}
function signed(v){const n=Number(v);return Number.isFinite(n)?(n>0?"+":"")+n.toFixed(1):String(v)}
