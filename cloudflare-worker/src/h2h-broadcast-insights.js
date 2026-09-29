import { normalizeWinlineMarket } from "./winline-market-adapter.js";

export async function buildH2HBroadcastInsights(db,game,providerMarkets=[]){
  if(!db||!game?.scheduled_start_utc||!game?.away_tri||!game?.home_tri)return[];
  const result=await db.prepare(`
    SELECT f.game_pk,f.final_goals_for,f.final_goals_against,f.total_goals,f.final_goal_diff,f.final_win,
           f.regulation_goals_for,f.regulation_goals_against,f.regulation_result,f.regulation_goal_diff,
           f.p1_goals_for,f.p1_goals_against,f.p2_goals_for,f.p2_goals_against,f.p3_goals_for,f.p3_goals_against,
           CASE WHEN f.is_home=1 THEN p1.home_goals ELSE p1.away_goals END AS raw_p1_goals_for,
           CASE WHEN f.is_home=1 THEN p1.away_goals ELSE p1.home_goals END AS raw_p1_goals_against,
           CASE WHEN f.is_home=1 THEN p2.home_goals ELSE p2.away_goals END AS raw_p2_goals_for,
           CASE WHEN f.is_home=1 THEN p2.away_goals ELSE p2.home_goals END AS raw_p2_goals_against,
           CASE WHEN f.is_home=1 THEN p3.home_goals ELSE p3.away_goals END AS raw_p3_goals_for,
           CASE WHEN f.is_home=1 THEN p3.away_goals ELSE p3.home_goals END AS raw_p3_goals_against
    FROM team_game_features f
    LEFT JOIN period_scores p1 ON p1.game_pk=f.game_pk AND p1.period_number=1 AND p1.period_type='REG'
    LEFT JOIN period_scores p2 ON p2.game_pk=f.game_pk AND p2.period_number=2 AND p2.period_type='REG'
    LEFT JOIN period_scores p3 ON p3.game_pk=f.game_pk AND p3.period_number=3 AND p3.period_type='REG'
    WHERE f.team_tri=? AND f.opponent_tri=? AND f.scheduled_start_utc<?
    ORDER BY f.scheduled_start_utc DESC,f.game_pk DESC
    LIMIT 10;
  `).bind(game.away_tri,game.home_tri,game.scheduled_start_utc).all();
  const rows=(result?.results||[]).map(prepareH2HRow);
  if(rows.length<3)return[];
  const markets=dedupe((providerMarkets||[]).filter(m=>!(m?.is_live===true||Number(m?.is_live||0)===1)).map(normalizeWinlineMarket).filter(Boolean));
  const out=[];
  for(const m of markets){
    const stat=evaluate(m,game,rows);
    if(!stat)continue;
    out.push(card(game,m,rows,stat));
  }
  return out.sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,30);
}

function prepareH2HRow(raw){
  const periods=[];
  for(let p=1;p<=3;p++){
    const gf=num(raw?.[`raw_p${p}_goals_for`]),ga=num(raw?.[`raw_p${p}_goals_against`]);
    const fGf=num(raw?.[`p${p}_goals_for`]),fGa=num(raw?.[`p${p}_goals_against`]);
    if(!Number.isInteger(gf)||!Number.isInteger(ga)||gf<0||ga<0||fGf!==gf||fGa!==ga)return {...raw,__period_verified:false};
    periods.push({gf,ga});
  }
  const regGf=num(raw?.regulation_goals_for),regGa=num(raw?.regulation_goals_against),regDiff=num(raw?.regulation_goal_diff);
  const sumGf=periods.reduce((s,x)=>s+x.gf,0),sumGa=periods.reduce((s,x)=>s+x.ga,0);
  if(regGf===null||regGa===null||regDiff===null||sumGf!==regGf||sumGa!==regGa||sumGf-sumGa!==regDiff)return {...raw,__period_verified:false};
  const out={...raw,__period_verified:true};
  for(let p=1;p<=3;p++){out[`p${p}_goals_for`]=periods[p-1].gf;out[`p${p}_goals_against`]=periods[p-1].ga;}
  return out;
}

function evaluate(m,game,rows){
  const type=String(m.market_type||""),side=String(m.side||"").toLowerCase(),subject=String(m.subject||"").toUpperCase(),line=num(m.line),period=String(m.period||"GAME");
  const periodBased=/^P[123]$/.test(period)||/^period_[123]_result$/.test(type);
  if(periodBased&&!rows.every(r=>r.__period_verified===true))return null;
  let fn=null;
  if(type==="game_total"&&line!==null)fn=r=>settleTotal(periodTotal(r,period),side,line);
  else if(type==="team_total"&&line!==null&&(subject===game.away_tri||subject===game.home_tri)){
    fn=r=>settleTotal(teamGoals(r,period,subject===game.away_tri),side,line);
  }else if(type==="handicap"&&line!==null&&(subject===game.away_tri||subject===game.home_tri)){
    fn=r=>settleHandicap((subject===game.away_tri?1:-1)*Number(r.final_goal_diff),line);
  }else if(type==="moneyline"&&(subject===game.away_tri||subject===game.home_tri)){
    fn=r=>subject===game.away_tri?(Number(r.final_win)===1?"win":"loss"):(Number(r.final_win)===0?"win":"loss");
  }else if(/^period_[123]_result$/.test(type)&&(subject===game.away_tri||subject===game.home_tri)){
    const p=Number(type.match(/^period_([123])_result$/)?.[1]);
    fn=r=>{const d=periodDiff(r,p)*(subject===game.away_tri?1:-1);return d>0?"win":"loss"};
  }else if(type==="double_chance"&&side==="team_or_draw"&&(subject===game.away_tri||subject===game.home_tri)){
    fn=r=>{const rr=String(r.regulation_result||"");if(!rr)return null;return subject===game.away_tri?(rr!=="L"?"win":"loss"):(rr!=="W"?"win":"loss")};
  }else if(type==="both_teams_score"){
    fn=r=>{const yes=Number(r.final_goals_for)>0&&Number(r.final_goals_against)>0;return side==="yes"?(yes?"win":"loss"):(yes?"loss":"win")};
  }
  if(!fn)return null;
  let hits=0,losses=0,pushes=0;
  for(const row of rows){const s=fn(row);if(s==="win")hits++;else if(s==="push")pushes++;else if(s==="loss")losses++}
  const decisions=hits+losses;if(decisions<3)return null;
  return {hits,losses,pushes,decisions,rate:hits/decisions,period_data_verified:periodBased?true:null};
}

function card(game,m,rows,s){
  const label=marketLabel(m),window=rows.length;
  const subject=String(m.subject||"").toUpperCase();
  const team=subject===String(game.home_tri||"").toUpperCase()||subject===String(game.away_tri||"").toUpperCase()?subject:String(game.away_tri||"").toUpperCase();
  const opponent=team===String(game.home_tri||"").toUpperCase()?String(game.away_tri||"").toUpperCase():String(game.home_tri||"").toUpperCase();
  const teamName=gameTeamName(game,team),opponentName=gameTeamName(game,opponent);
  const title=String(m.market_type||"")==="moneyline"
    ?fitTitle(teamName+" ОБЫГРЫВАЛИ "+opponentName+" В "+s.hits+" ИЗ "+s.decisions+" ПОСЛЕДНИХ МАТЧЕЙ",shortName(teamName)+": "+s.hits+" ИЗ "+s.decisions+" ПОБЕД ПРОТИВ "+shortName(opponentName))
    :fitTitle(label+" ПРОТИВ "+opponentName+" — "+s.hits+" ИЗ "+s.decisions+" ПОСЛЕДНИХ МАТЧЕЙ",label+": "+s.hits+" ИЗ "+s.decisions+" ПРОТИВ "+shortName(opponentName));
  return {
    id:String(game.game_pk)+":h2h-current-line:"+key(m),
    insight_type:"h2h_current_line",category:"h2h_broadcast",kind:"history",timing:"pregame",
    score:Math.min(94,62+Math.round(s.rate*24)+Math.min(8,window)),
    eyebrow:"ЛИЧНЫЕ ВСТРЕЧИ · "+window,
    value:s.hits+"/"+s.decisions,
    title,
    explanation:"Последние "+window+" очных матчей "+teamName+" и "+opponentName+". Рассчитана именно текущая линия WINLINE, без подмены соседней линией.",
    evidence:{split:"h2h",window,sample:window,hits:s.hits,decisions:s.decisions,pushes:s.pushes,hit_rate:s.rate,team,opponent,game_pks:rows.map(r=>Number(r.game_pk)),exact_provider_line:true,period_data_verified:s.period_data_verified,stats_validation:"exact_market_v4_raw_period_crosscheck",feature_layer:"h2h_current_winline_line_v2"},
    market:{type:m.market_type,period:m.period,subject:m.subject,side:m.side,line:m.line,label,odds:m.odds,provider:m.provider,odds_is_demo:false,odds_source:"provider_live",event_id:m.event_id,market_id:m.market_id,selection_id:m.selection_id,updated_at:m.updated_at,deeplink:m.deeplink}
  };
}
function gameTeamName(game,tri){
  const t=String(tri||"").toUpperCase();
  if(t===String(game.home_tri||"").toUpperCase())return String(game.home_name_ru||game.home_name||t).trim().toUpperCase();
  if(t===String(game.away_tri||"").toUpperCase())return String(game.away_name_ru||game.away_name||t).trim().toUpperCase();
  return t;
}
function shortName(value){return String(value||"").trim().split(/\s+/)[0]||String(value||"").trim()}
function fitTitle(full,compact){return String(full||"").length<=96?full:compact}
function periodTotal(r,p){if(p==="GAME"||p==="REG")return Number(r.total_goals);const n=Number(String(p).replace("P",""));return Number(r["p"+n+"_goals_for"])+Number(r["p"+n+"_goals_against"])}
function teamGoals(r,p,awayPerspective){if(p==="GAME"||p==="REG")return Number(awayPerspective?r.final_goals_for:r.final_goals_against);const n=Number(String(p).replace("P",""));return Number(r["p"+n+(awayPerspective?"_goals_for":"_goals_against")])}
function periodDiff(r,p){return Number(r["p"+p+"_goals_for"])-Number(r["p"+p+"_goals_against"])}
function settleTotal(v,side,line){if(!Number.isFinite(v))return null;if(v===line)return"push";return side==="under"?(v<line?"win":"loss"):(v>line?"win":"loss")}
function settleHandicap(diff,line){const x=Number(diff)+Number(line);if(x===0)return"push";return x>0?"win":"loss"}
function marketLabel(m){const t=String(m.market_type||""),s=String(m.subject||""),side=String(m.side||"").toLowerCase(),l=num(m.line),p=String(m.period||"GAME");const pr=p==="P1"?"1-Й ПЕРИОД · ":p==="P2"?"2-Й ПЕРИОД · ":p==="P3"?"3-Й ПЕРИОД · ":"";if(t==="game_total")return pr+(side==="under"?"ТОТАЛ МЕНЬШЕ ":"ТОТАЛ БОЛЬШЕ ")+fmt(l);if(t==="team_total")return pr+s+" "+(side==="under"?"ТОТАЛ КОМАНДЫ МЕНЬШЕ ":"ТОТАЛ КОМАНДЫ БОЛЬШЕ ")+fmt(l);if(t==="handicap")return pr+s+" ФОРА "+signed(l);if(t==="moneyline")return "ПОБЕДА "+s;if(/^period_[123]_result$/.test(t))return pr+"ПОБЕДА "+s;if(t==="double_chance")return s+" ИЛИ НИЧЬЯ";if(t==="both_teams_score")return side==="yes"?"ОБЕ ЗАБЬЮТ — ДА":"ОБЕ ЗАБЬЮТ — НЕТ";return [pr,t,s,side].filter(Boolean).join(" ")}
function key(m){return [m.market_type,m.period,m.subject||"all",m.side||"none",num(m.line)===null?"none":Number(m.line).toFixed(2)].join(":")}
function dedupe(ms){const seen=new Set(),out=[];for(const m of ms){const k=key(m);if(seen.has(k))continue;seen.add(k);out.push(m)}return out}
function num(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function fmt(v){const n=num(v);return n===null?"":String(n).replace(".",",")}
function signed(v){const n=num(v);return n===null?"":(n>0?"+":"")+fmt(n)}
