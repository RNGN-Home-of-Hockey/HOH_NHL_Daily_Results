// Select exactly four primary broadcast cards:
// 2 current-team/matchup stories + 2 head-to-head stories.
// This is a presentation selector only. It does not change the underlying candidate pool.

export function selectBroadcastFour(cards=[],game={}){
  const all=(cards||[]).filter(Boolean);
  const h2h=all.filter(isTeamH2H);
  const general=all.filter(c=>!isTeamH2H(c)&&isTeamLevel(c));

  const pickedGeneral=pickGeneral(general,game,2);
  const pickedH2H=pickH2H(h2h,2);

  return [
    ...pickedGeneral.map((c,i)=>tag(c,"team_form",i)),
    ...pickedH2H.map((c,i)=>tag(c,"h2h",i)),
  ];
}

export function isTeamH2H(card){
  if(!card)return false;
  const category=String(card.category||"").toLowerCase();
  const type=String(card.insight_type||"").toLowerCase();
  const split=String(card.evidence?.split||"").toLowerCase();
  if(category==="player_h2h"||type.includes("player"))return false;
  return split==="h2h"||category==="h2h_market"||type==="h2h_dominance"||type.startsWith("h2h_");
}

function isTeamLevel(card){
  const category=String(card.category||"").toLowerCase();
  const type=String(card.insight_type||"").toLowerCase();
  const marketType=String(card.market?.type||"").toLowerCase();
  if(category.includes("player")||type.includes("player")||marketType.startsWith("player_"))return false;
  if(category==="goalie_context"&&card.evidence?.requires_start_confirmation===true)return false;
  return true;
}

function pickGeneral(cards,game,limit){
  const sorted=[...cards].sort(compare);
  const home=String(game.home_tri||"").toUpperCase();
  const away=String(game.away_tri||"").toUpperCase();
  const out=[];
  const used=new Set();

  // First preference: give the commentator one current story about each team.
  for(const tri of [away,home]){
    if(!tri)continue;
    const hit=sorted.find(c=>!used.has(key(c))&&teamOf(c,game)===tri&&hasUsefulNumber(c)&&isConcreteStory(c));
    if(hit){out.push(hit);used.add(key(hit))}
  }

  // Fill with a matchup/game-level angle, then any strong distinct card.
  for(const card of sorted){
    if(out.length>=limit)break;
    if(used.has(key(card)))continue;
    if(!hasUsefulNumber(card)||!isConcreteStory(card))continue;
    if(tooSimilar(card,out))continue;
    out.push(card);used.add(key(card));
  }

  return out.slice(0,limit);
}

function pickH2H(cards,limit){
  const sorted=[...cards].sort(compare);
  const out=[],usedFamilies=new Set();
  // Prefer two different H2H stories: e.g. result/handicap + scoring total.
  for(const card of sorted){
    if(out.length>=limit)break;
    if(!hasUsefulNumber(card)||!isConcreteStory(card))continue;
    const family=marketFamily(card);
    if(usedFamilies.has(family))continue;
    out.push(card);usedFamilies.add(family);
  }
  for(const card of sorted){
    if(out.length>=limit)break;
    if(out.includes(card)||!hasUsefulNumber(card)||!isConcreteStory(card)||tooSimilar(card,out))continue;
    out.push(card);
  }
  return out.slice(0,limit);
}

function compare(a,b){
  const priced=Number(hasRealPrice(b))-Number(hasRealPrice(a));
  if(priced)return priced;
  const air=score(b)-score(a);
  if(air)return air;
  const bw=Number(b.evidence?.window||b.evidence?.sample||0)-Number(a.evidence?.window||a.evidence?.sample||0);
  if(bw)return bw;
  return String(a.id||"").localeCompare(String(b.id||""));
}
function hasRealPrice(c){const o=Number(c?.market?.odds);return Number.isFinite(o)&&o>1&&c?.market?.odds_is_demo===false&&c?.market?.odds_source==="provider_live"}
function score(c){const n=Number(c?.air_score??c?.portfolio_score??c?.score);return Number.isFinite(n)?n:0}
function hasUsefulNumber(c){return /\d/.test(String(c?.broadcast_title||c?.title||c?.value||""))||Number.isFinite(Number(c?.evidence?.hits))||Number.isFinite(Number(c?.evidence?.team_rank))}
function isConcreteStory(c){const s=String(c?.broadcast_title||c?.title||"").toUpperCase();return !/НЕЗАВИСИМ.*СИГНАЛ|ПОДТВЕРЖДАЮТ.*СИГНАЛ|РАЗНЫЕ СТАТИСТИЧЕСКИЕ СЛОИ|DATA CORE/.test(s)}
function teamOf(c,game){
  const candidates=[c?.market?.subject,c?.evidence?.team,c?.team_tri,c?.evidence?.subject_team];
  const home=String(game.home_tri||"").toUpperCase(),away=String(game.away_tri||"").toUpperCase();
  for(const raw of candidates){const t=String(raw||"").toUpperCase();if(t===home||t===away)return t}
  return "";
}
function marketFamily(c){
  const t=String(c?.market?.type||"unknown");
  if(["moneyline","handicap","double_chance"].includes(t))return"result";
  if(["game_total","both_teams_score"].includes(t))return"game_scoring";
  if(["team_total","team_goal_bucket"].includes(t))return"team_scoring";
  if(/^period_/.test(t)||String(c?.market?.period||"GAME")!=="GAME")return"period";
  return t;
}
function tooSimilar(card,out){
  const fam=marketFamily(card);
  const team=String(card?.market?.subject||card?.evidence?.team||"");
  return out.some(x=>marketFamily(x)===fam&&String(x?.market?.subject||x?.evidence?.team||"")===team);
}
function key(c){return String(c?.id||[c?.market?.type,c?.market?.subject,c?.market?.side,c?.market?.line].join(":"))}
function tag(card,group,index){
  return {...card,broadcast_group:group,broadcast_group_order:index,broadcast_group_label:group==="h2h"?"ЛИЧНЫЕ ВСТРЕЧИ":"ФОРМА КОМАНД"};
}
