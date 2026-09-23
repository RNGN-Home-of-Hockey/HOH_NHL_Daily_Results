// Compact commentator brief: 3-5 scan-friendly points, no model internals.
export function buildCommentatorBrief(card={},game={}){
  const e=card.evidence||{},m=card.market||{};
  const group=card.broadcast_group==="h2h"?"ЛИЧНЫЕ ВСТРЕЧИ":"ТЕКУЩАЯ ФОРМА";
  const points=[];
  points.push({label:"ГЛАВНОЕ",text:clean(card.broadcast_title||card.title||card.value||"")});
  const number=numberPoint(card,e);
  if(number)points.push({label:"ЦИФРА",text:number});
  const context=contextPoint(card,e,game);
  if(context)points.push({label:card.broadcast_group==="h2h"?"ОЧНЫЕ МАТЧИ":"КОНТЕКСТ",text:context});
  const line=linePoint(m);
  if(line)points.push({label:"ЛИНИЯ",text:line});
  points.push({label:"В ЭФИР",text:sayPoint(card,e,m,game)});
  return {group,points:dedupe(points).slice(0,5)};
}
function numberPoint(card,e){
  const hits=n(e.hits),sample=n(e.decisions??e.sample??e.games),rate=n(e.hit_rate);
  if(hits!==null&&sample!==null)return Math.round(hits)+" из "+Math.round(sample)+(rate!==null?" · "+Math.round(rate*100)+"%":"");
  const rank=n(e.team_rank??e.rank);
  if(rank!==null)return "№"+Math.round(rank)+" в НХЛ";
  const pp=n(e.pp_pct);if(pp!==null)return Math.round(pp*100)+"% реализации большинства";
  const pk=n(e.opponent_pk_pct);if(pk!==null)return Math.round(pk*100)+"% меньшинства соперника";
  const window=n(e.window);if(window!==null)return "выборка "+Math.round(window)+" матчей";
  return null;
}
function contextPoint(card,e,game){
  if(String(e.split||"").toLowerCase()==="h2h"){
    const window=n(e.window??e.sample);
    return window!==null?"только последние "+Math.round(window)+" очных матчей этих команд":"только очные встречи этих команд";
  }
  const rank=n(e.team_rank),opp=n(e.opponent_rank);
  if(rank!==null&&opp!==null){
    const team=teamName(e.team||card.market?.subject,game),other=teamName(e.opponent,game);
    if(team&&other)return team+": №"+Math.round(rank)+" · "+other+": №"+Math.round(opp);
  }
  const windows=Array.isArray(e.trend_windows)?e.trend_windows:[];
  if(windows.length>=2){
    const a=windows[0],b=windows[1];
    if(n(a.hits)!==null&&n(a.decisions)!==null&&n(b.hits)!==null&&n(b.decisions)!==null){
      return a.hits+"/"+a.decisions+" за "+a.window+" матчей · "+b.hits+"/"+b.decisions+" за "+b.window;
    }
  }
  const support=Math.max(Number(e.independent_support_count||0),Array.isArray(e.supporting_signals)?e.supporting_signals.length:0);
  if(support>0)return "есть ещё "+support+" независим"+(support===1?"ое подтверждение":"ых подтверждения");
  return null;
}
function linePoint(m){
  const odds=n(m.odds),label=clean(m.label||marketLabel(m));
  if(!label)return null;
  return odds!==null?label+" · кэф "+odds.toFixed(2):label;
}
function sayPoint(card,e,m,game){
  const title=clean(card.broadcast_title||card.title||card.value||"");
  if(String(e.split||"").toLowerCase()==="h2h")return title?"В очных матчах: "+sentence(title):"Сравни очные встречи и текущую линию.";
  return title?sentence(title):"Коротко проговори главный статистический факт и текущую линию.";
}
function marketLabel(m){
  const t=String(m.type||""),team=String(m.subject||""),side=String(m.side||""),line=n(m.line);
  if(t==="moneyline")return "Победа "+team;
  if(t==="game_total")return (side==="under"?"ТМ":"ТБ")+" "+fmt(line);
  if(t==="team_total")return team+" "+(side==="under"?"ИТМ":"ИТБ")+" "+fmt(line);
  if(t==="handicap")return team+" фора "+signed(line);
  return "";
}
function teamName(code,game){
  const t=String(code||"").toUpperCase();
  if(!t)return"";
  if(t===String(game.home_tri||"").toUpperCase())return String(game.home_name_ru||game.home_name||t).toUpperCase();
  if(t===String(game.away_tri||"").toUpperCase())return String(game.away_name_ru||game.away_name||t).toUpperCase();
  return t;
}
function sentence(v){const s=String(v||"").trim();return s.charAt(0)+s.slice(1).toLowerCase()}
function clean(v){return String(v||"").replace(/\s+/g," ").trim()}
function dedupe(points){const seen=new Set();return points.filter(p=>{const k=String(p.text||"").toLowerCase();if(!k||seen.has(k))return false;seen.add(k);return true})}
function n(v){if(v===null||v===undefined||v==="")return null;const x=Number(v);return Number.isFinite(x)?x:null}
function fmt(v){const x=n(v);return x===null?"":String(x).replace(".",",")}
function signed(v){const x=n(v);return x===null?"":(x>0?"+":"")+fmt(x)}
