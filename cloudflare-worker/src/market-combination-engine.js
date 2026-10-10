
import { normalizeWinlineMarket } from "./winline-market-adapter.js";

const MAX_MARKETS=240,MAX_ATOMS=10,MAX_SINGLES=5,MAX_PAIRS=8;

export function buildMarketCombinationInsights(insights,providerMarkets,game,options={}){
  if(!Array.isArray(insights)||!insights.length||!Array.isArray(providerMarkets)||!providerMarkets.length)return[];
  const now=resolveNow(options.now),maxAge=positive(options.market_max_age_ms,7*60*60*1000);
  const markets=providerMarkets.map(normalizeWinlineMarket).filter(Boolean).filter(m=>fresh(m,now,maxAge)).slice(0,MAX_MARKETS);
  const atoms=insights.map(c=>atom(c,game)).filter(Boolean),out=[];
  for(const market of markets){
    const rows=atoms.map(a=>({a,n:compat(a,market)})).filter(x=>x.n>=35)
      .sort((x,y)=>y.n-x.n||y.a.score-x.a.score).slice(0,MAX_ATOMS);
    for(let i=0;i<Math.min(MAX_SINGLES,rows.length);i++){const c=single(game,market,rows[i],i);if(c)out.push(c)}
    let pairs=0;
    for(let i=0;i<rows.length&&pairs<MAX_PAIRS;i++)for(let j=i+1;j<rows.length&&pairs<MAX_PAIRS;j++){
      if(!independent(rows[i].a,rows[j].a)||!agrees(rows[i].a,rows[j].a,market))continue;
      const c=pair(game,market,rows[i],rows[j],pairs);
      if(c){out.push(c);pairs++}
    }
  }
  return dedupe(out).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}

function atom(card,game){
  if(!card)return null;
  const m=card.market||{},e=card.evidence||{},category=String(card.category||card.insight_type||"unknown");
  const team=up(m.subject||(!obj(e.team)?e.team:null)||e.team_tri||""),opponent=up((!obj(e.opponent)?e.opponent:null)||e.opponent_tri||opp(team,game));
  return {
    id:String(card.id||card.insight_type||category),category,team,opponent,
    type:String(m.type||""),period:period(m.period),subject:up(m.subject||""),side:String(m.side||"").toLowerCase(),line:num(m.line),
    direction:direction(card,team),sample:maxnum([e.sample_size,e.sample,e.window,e.games,e.attack?.sample,e.cover?.sample,e.away?.sample,e.home?.sample]),
    hit:firstnum([e.hit_rate,e.historical_rate,e.rate,e.combined_rate,card.hit_rate,card.combined_rate]),
    lineBound:isLineBoundCard(card,e,category),
    metric:String(e.metric||e.opponent_metric||e.feature_layer||category).toLowerCase(),
    score:Number(card.portfolio_score??card.score??50),title:String(card.title||card.value||card.eyebrow||""),
    value:String(card.value||""),explanation:String(card.explanation||card.note||""),evidence:e,source:card
  };
}

function compat(a,m){
  const t=String(m.market_type||""),sub=up(m.subject||""),p=period(m.period),target=marketDirection(m);let s=0;
  // Directional team evidence is not "context" for the opposite side.
  // Example: CAR ranks #2 and FLA #18 cannot be used to sell FLA -1.
  // Reject it before scoring instead of letting generic family/sample bonuses
  // overpower the direction mismatch.
  if(target&&a.direction&&String(target).startsWith("team:")&&String(a.direction).startsWith("team:")&&target!==a.direction)return -100;
  if(a.type===t)s+=34;else if(family(a.type,t))s+=22;else if(cross(a,t))s+=14;
  if(a.period===p)s+=18;else if(a.period==="GAME"&&p==="REG")s+=7;else if(!["GAME","REG"].includes(p))s-=12;
  if(sub){if(a.team===sub||a.subject===sub)s+=22;else if(a.opponent===sub&&opponentUseful(a,t))s+=10;else if(a.subject&&a.subject!==sub)s-=18}else if(t==="game_total")s+=8;
  if(target&&a.direction){if(target===a.direction)s+=18;else if(oppositeDirection(target)===a.direction)s-=20}
  if(a.hit!==null)s+=7;if(a.sample>=20)s+=8;else if(a.sample>=10)s+=5;if(a.score>=90)s+=8;else if(a.score>=80)s+=5;
  if(["market_evaluator","regulation_market","venue_split"].includes(a.category))s+=8;
  if(["advanced_rolling_venue","advanced_market"].includes(a.category))s+=7;
  if(a.category==="goalie_context"&&["team_total","game_total"].includes(t))s+=8;
  if(a.category==="player_market"&&t.startsWith("player_"))s+=12;
  const ml=num(m.line);
  if(a.line!==null&&ml!==null){
    const d=Math.abs(a.line-ml);
    if(d<.001)s+=18;
    else if(a.lineBound)return -100;
    else if(d<=1)s+=3;
  }
  return s;
}

function single(game,m,row,i){
  const a=row.a,label=labelFor(m),score=clip(Math.round(a.score*.62+row.n*.48));
  const targetFrequencyVerified=exactAtomMarket(a,m);
  // A hit rate belongs to the market it was measured on. "BOS scored 4 or less in 15 of 20 home games" says nothing
  // about the game total, so a rate-bearing fact is never presented as the history of a different market.
  if(!targetFrequencyVerified&&claimsFrequency(a))return null;
  return {
    id:String(game.game_pk)+":combo:s:"+key(m)+":"+safe(a.id)+":"+i,insight_type:"market_combination_single",category:"market_combination",
    kind:"history",timing:"pregame",score,eyebrow:"WINLINE × DATA CORE",value:a.value||label,title:a.title||label,
    explanation:join(a.explanation,"Факт автоматически привязан к реальной линии WINLINE: "+label+"."),
    evidence:{...clone(a.evidence),market_combination:true,market_first:true,primary_source_category:a.category,combination_support_count:1,combination_compatibility:row.n,source_insight_ids:[a.id],provider_market_key:key(m),source_market_key:atomMarketKey(a),target_market_frequency_verified:targetFrequencyVerified},
    market:asMarket(m)
  };
}

function pair(game,m,ar,br,i){
  const a=ar.a,b=br.a,primary=primaryAtomForMarket(a,b,m),support=primary===a?b:a,label=labelFor(m);
  const score=clip(Math.round(Math.min(a.score,b.score)*.50+((ar.n+br.n)/2)*.42+15));
  const targetFrequencyVerified=exactAtomMarket(primary,m);
  if(!targetFrequencyVerified&&claimsFrequency(primary))return null;
  return {
    id:String(game.game_pk)+":combo:p:"+key(m)+":"+safe(a.id)+":"+safe(b.id)+":"+i,insight_type:"market_combination_pair",category:"market_combination",
    kind:"history",timing:"pregame",score,eyebrow:"WINLINE × DATA CORE",value:primary.value||label,title:primary.title||label,
    explanation:join(primary.explanation,"Дополнительный факт: "+(support.title||support.category)+".","Оба факта связаны с текущей линией WINLINE: "+label+"."),
    evidence:{...clone(primary.evidence),market_combination:true,market_first:true,primary_source_category:primary.category,combination_support_count:2,
      combination_compatibility:Math.round((ar.n+br.n)/2),source_insight_ids:[a.id,b.id],provider_market_key:key(m),source_market_key:atomMarketKey(primary),target_market_frequency_verified:targetFrequencyVerified,
      supporting_signals:[{category:support.category,insight_type:support.source?.insight_type||null,score:support.score,title:support.title,value:support.value,evidence:clone(support.evidence)}]},
    market:asMarket(m)
  };
}

function primaryAtomForMarket(a,b,m){
  const q=x=>{
    let score=Number(x?.score||0)/100;
    if(exactAtomMarket(x,m))score+=100;
    if(x?.hit!==null&&x?.hit!==undefined)score+=40;
    if(Number(x?.sample||0)>=10)score+=Math.min(20,Number(x.sample)/2);
    if(x?.lineBound)score+=8;
    return score;
  };
  return q(a)>=q(b)?a:b;
}
function exactAtomMarket(a,m){
  return atomMarketKey(a)===key(m);
}
function claimsFrequency(a){return a?.hit!==null&&a?.hit!==undefined}
function atomMarketKey(a){
  if(!a)return"";
  return [a.type||"unknown",a.period||"GAME",a.subject||"all",a.side||"none",a.line===null||a.line===undefined?"none":Number(a.line).toFixed(2)].join(":");
}

function isLineBoundCard(card,e,category){
  const type=String(card?.market?.type||"");
  if(num(card?.market?.line)===null)return false;
  const contextual=new Set(["advanced_market","advanced_rolling_venue","advanced_context","league_rank","goalie_context","special_teams","matchup"]);
  if(contextual.has(category)&&firstnum([e?.hit_rate,e?.historical_rate,e?.rate,e?.combined_rate])===null)return false;
  if(String(e?.role||"").includes("context"))return false;
  if(["game_total","team_total","handicap","result_total_combo"].includes(type))return true;
  if(type.startsWith("player_"))return true;
  return firstnum([e?.hit_rate,e?.historical_rate,e?.rate,e?.combined_rate])!==null;
}

function independent(a,b){
  if(a.id===b.id)return false;if(a.category!==b.category)return true;
  const fa=String(a.evidence?.feature_layer||""),fb=String(b.evidence?.feature_layer||"");if(fa&&fb&&fa!==fb)return true;
  const wa=num(a.evidence?.window),wb=num(b.evidence?.window);return wa!==null&&wb!==null&&wa!==wb;
}
function agrees(a,b,m){const t=marketDirection(m);return !t||(![a.direction,b.direction].includes(oppositeDirection(t)))}
function direction(card,team){
  const m=card.market||{},side=String(m.side||"").toLowerCase(),type=String(m.type||"");
  if(["game_total","team_total","player_points","player_goals","player_shots","player_assists","player_blocks","player_hits"].includes(type))return ["over","under"].includes(side)?side:null;
  if(["moneyline","handicap"].includes(type)||/^period_\d+_result$/.test(type))return up(m.subject||team)?"team:"+up(m.subject||team):null;
  const role=String(card.evidence?.role||card.evidence?.reason||"").toLowerCase();
  if(/under|weak_attack|elite_defense/.test(role))return "under";
  if(/over|attack|dominance|control/.test(role))return team?"team:"+team:"over";
  return null;
}
function marketDirection(m){
  const t=String(m.market_type||""),side=String(m.side||"").toLowerCase();
  if(["game_total","team_total","player_points","player_goals","player_shots","player_assists","player_blocks","player_hits"].includes(t))return ["over","under"].includes(side)?side:null;
  if(["moneyline","handicap","first_goal_team","next_goal_team"].includes(t)||/^period_\d+_result$/.test(t)){const s=up(m.subject||side);return s?"team:"+s:null}
  return null;
}
function family(a,b){
  if(a===b)return true;const r=["moneyline","handicap","period_1_result","period_2_result","period_3_result","first_goal_team","next_goal_team","double_chance","win_all_periods"],t=["game_total","team_total"];
  return (r.includes(a)&&r.includes(b))||(t.includes(a)&&t.includes(b));
}
function cross(a,t){
  if(["moneyline","handicap","period_1_result","period_2_result","period_3_result","next_goal_team"].includes(t))return ["moneyline","handicap"].includes(a.type)||/control|dominance|advanced|h2h|regulation|venue/.test(a.category+" "+a.metric);
  if(t==="team_total")return ["team_total","game_total"].includes(a.type)||/goalie|attack|xgf|shot|special|player/.test(a.category+" "+a.metric);
  if(t==="game_total")return ["game_total","team_total"].includes(a.type)||/goalie|pace|xg|shot|special/.test(a.category+" "+a.metric);
  if(t==="both_teams_score")return ["game_total","team_total","both_teams_score"].includes(a.type)||/goalie|attack|defen|xgf|xga|shot|special/.test(a.category+" "+a.metric);
  if(t==="team_goal_bucket")return ["team_total","team_goal_bucket"].includes(a.type)||/attack|goalie|xgf|shot/.test(a.category+" "+a.metric);
  if(t==="highest_scoring_period")return a.type==="highest_scoring_period"||/period/.test(a.category+" "+a.metric);
  if(t==="result_total_combo")return ["moneyline","handicap","game_total","result_total_combo"].includes(a.type);
  if(t.startsWith("player_"))return a.type===t||a.category.includes("player");return false;
}
function opponentUseful(a,t){return t==="team_total"?/defen|goalie|xga|sa60|opponent/.test(a.category+" "+a.metric+" "+a.evidence?.role):["moneyline","handicap","game_total"].includes(t)}
function asMarket(m){return {type:m.market_type,period:m.period,subject:m.subject,side:m.side,line:m.line,label:labelFor(m),odds:m.odds,provider:m.provider,odds_is_demo:false,odds_source:"provider_live",event_id:m.event_id,market_id:m.market_id,selection_id:m.selection_id,updated_at:m.updated_at,deeplink:m.deeplink}}
function labelFor(m){
  const t=String(m.market_type||""),s=m.subject?String(m.subject):"",l=num(m.line),x=l===null?"":(t==="handicap"?lineText(l):plainLineText(l)),period=String(m.period||"GAME").toUpperCase(),p=period==="P1"?"1-Й ПЕРИОД · ":period==="P2"?"2-Й ПЕРИОД · ":period==="P3"?"3-Й ПЕРИОД · ":period==="REG"?"60 МИНУТ · ":"";
  if(t==="moneyline")return (p+"ПОБЕДА "+(s||String(m.side||"").toUpperCase())).trim();
  if(t==="handicap")return (p+s+" ФОРА "+x).trim();
  if(t==="team_total")return (p+s+" "+(m.side==="over"?"ТОТАЛ КОМАНДЫ БОЛЬШЕ":"ТОТАЛ КОМАНДЫ МЕНЬШЕ")+" "+x).trim();
  if(t==="game_total")return (p+(m.side==="over"?"ОБЩИЙ ТОТАЛ БОЛЬШЕ":"ОБЩИЙ ТОТАЛ МЕНЬШЕ")+" "+x).trim();
  if(t==="first_goal_team")return "ПЕРВЫЙ ГОЛ — "+s;
  if(t==="next_goal_team")return "СЛЕДУЮЩИЙ ГОЛ — "+s;
  if(t==="double_chance")return s+" НЕ ПРОИГРАЕТ В ОСНОВНОЕ ВРЕМЯ";
  if(t==="team_goal_bucket")return s+" · "+String(m.side||"").replace("0_1","0–1").replace("3_plus","3+")+" ШАЙБЫ";
  if(t==="highest_scoring_period")return s+" · САМЫЙ РЕЗУЛЬТАТИВНЫЙ "+String(m.side||"");
  if(t==="win_all_periods")return s+" · ВЫИГРАЕТ ВСЕ ПЕРИОДЫ";
  if(t==="result_total_combo")return "ПОБЕДА "+s+" + "+(m.side==="over"?"ТОТАЛ БОЛЬШЕ":"ТОТАЛ МЕНЬШЕ")+" "+x;
  return [p,t,s,m.side,x].filter(Boolean).join(" ").trim();
}
function key(m){return [m.market_type||"unknown",m.period||"GAME",m.subject||"all",m.side||"none",num(m.line)===null?"none":Number(m.line).toFixed(2)].join(":")}
function fresh(m,now,maxAge){const t=Date.parse(m.updated_at);return ["open","active","opened"].includes(String(m.status||"open").toLowerCase())&&Number.isFinite(t)&&now-t<=maxAge&&now-t>=-60000}
function period(v){const s=String(v||"GAME").toUpperCase();if(["FULL","ALL","OT_SO","INCLUDING_OT_SO"].includes(s))return"GAME";if(["REGULATION","60M"].includes(s))return"REG";if(["1","PERIOD1","PERIOD_1"].includes(s))return"P1";if(["2","PERIOD2","PERIOD_2"].includes(s))return"P2";if(["3","PERIOD3","PERIOD_3"].includes(s))return"P3";return s||"GAME"}
function opp(team,game){const t=up(team);if(t===up(game?.home_tri))return up(game?.away_tri);if(t===up(game?.away_tri))return up(game?.home_tri);return""}
function oppositeDirection(v){return v==="over"?"under":v==="under"?"over":null}
function maxnum(xs){const a=xs.map(num).filter(x=>x!==null);return a.length?Math.max(...a):null}
function firstnum(xs){for(const x of xs){const n=num(x);if(n!==null)return n}return null}
function num(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function positive(v,f){const n=Number(v);return Number.isFinite(n)&&n>0?n:f}
function resolveNow(v){if(v instanceof Date)return v.getTime();if(typeof v==="number"&&Number.isFinite(v))return v;if(typeof v==="string"&&Number.isFinite(Date.parse(v)))return Date.parse(v);return Date.now()}
function up(v){return String(v||"").trim().toUpperCase()} function obj(v){return Boolean(v)&&typeof v==="object"&&!Array.isArray(v)}
function clone(v){if(!v)return{};if(typeof structuredClone==="function")return structuredClone(v);return JSON.parse(JSON.stringify(v))}
function join(...xs){return xs.filter(Boolean).join(" ")} function safe(v){return String(v||"x").replace(/[^a-zA-Z0-9_-]+/g,"_").slice(0,80)}
function clip(v){return Math.max(0,Math.min(99,v))} function lineText(v){const s=(Math.round(Number(v)*100)/100).toString().replace(".",",");return Number(v)>0?"+"+s:s}
// Totals are never signed ("МЕНЬШЕ 4,5", not "МЕНЬШЕ +4,5"); only handicap lines carry a sign.
function plainLineText(v){return (Math.round(Number(v)*100)/100).toString().replace(".",",")}
function dedupe(cards){const seen=new Set(),out=[];for(const c of cards){const k=String(c.id||"");if(k&&seen.has(k))continue;if(k)seen.add(k);out.push(c)}return out}
