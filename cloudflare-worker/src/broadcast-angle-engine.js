// Structured TV-angle generator.
// One source card -> several numerical, human-readable broadcast stories.

export function buildBroadcastAngles(card={},profile={}){
  const e=card.evidence||{},m=card.market||{},out=[];
  addHistory(out,e,m);
  addRanks(out,profile,m);
  addWindows(out,e,m);
  addPlayer(out,e,m);
  addSpecial(out,e,m);
  addLive(out,e,m);
  addScoreState(out,e,m);
  addSupport(out,e,m);
  const fallback=String(card.broadcast_title||card.title||card.value||"").trim();
  if(fallback){
    const numeric=/\d/.test(fallback);
    const advancedRank=profile?.team&&n(profile?.teamRank)!==null;
    const sourceScore=numeric&&!advancedRank?110:numeric?80:52;
    put(out,"source","source_fact",ensureNumber(fallback,card,profile),marketSub(m),sourceScore,"исходный факт уже сформулирован человечески");
  }

  return unique(out)
    .map(x=>({...x,title:x.family==="source_fact"?cleanSource(x.title):clean(x.title),score:score(x,card)}))
    .filter(x=>x.title&&x.title.length<=118)
    .sort((a,b)=>b.score-a.score||a.title.length-b.title.length)
    .slice(0,24);
}

export function diversifyBroadcastAngles(cards=[]){
  const familyCount=new Map(),shapes=new Set();
  return cards.map((card,index)=>{
    const vars=Array.isArray(card.broadcast_angle_variants)?card.broadcast_angle_variants:[];
    if(!vars.length)return card;
    let best=vars[0],bestScore=-1e9;
    for(const v of vars){
      const f=String(v.family||"other"),shape=titleShape(v.title);
      let s=Number(v.score||0)-(familyCount.get(f)||0)*8-(shapes.has(shape)?24:0);
      if(index<8&&(familyCount.get(f)||0)>=2)s-=12;
      if(s>bestScore){best=v;bestScore=s}
    }
    const f=String(best.family||"other");
    familyCount.set(f,(familyCount.get(f)||0)+1);shapes.add(titleShape(best.title));
    return {...card,broadcast_title:best.title,broadcast_subtitle:best.subtitle||card.broadcast_subtitle||null,
      broadcast_angle_id:best.id,broadcast_angle_family:f,broadcast_angle_reason:best.reason||null};
  });
}

function addHistory(out,e,m){
  const hits=n(e.hits),dec=n(e.decisions??e.sample??e.games),rate=n(e.hit_rate),window=n(e.window);
  if(hits===null||dec===null||dec<=0)return;
  const label=marketLabel(m),pct=Math.round((rate!==null?rate:hits/dec)*100),push=n(e.pushes)||0;
  put(out,"history_count","hit_rate",`${label} — ${Math.round(hits)} ИЗ ${Math.round(dec)}`,window?`ПОСЛЕДНИЕ ${Math.round(window)} МАТЧЕЙ`:"",96,"точная частота линии");
  put(out,"history_pct","hit_rate_pct",`${label} — ${pct}% ПРОХОДА`,`ВЫБОРКА ${Math.round(dec)}`,91,"процент прохода линии");
  if(push>0)put(out,"history_push","integer_line",`${label} — ${Math.round(hits)} ПОБЕД И ${Math.round(push)} ВОЗВРАТА`,`${Math.round(dec)} РЕШЁННЫХ ИСХОДОВ`,89,"целая линия с возвратами");
  const streak=n(e.current_streak);
  if(streak>=3)put(out,"streak","streak",`${label} ПРОХОДИТ ${Math.round(streak)} МАТЧА ПОДРЯД`,"ТЕКУЩАЯ СЕРИЯ",97,"серия по той же линии");
}
function addRanks(out,p,m){
  if(!p?.team||n(p.teamRank)===null)return;
  const rank=Math.round(p.teamRank),metric=String(p.meta?.tv||"ПОКАЗАТЕЛЮ");
  put(out,"league_rank","league_rank",`${p.team} — ${rank<=5?`ТОП-${rank}`:`№${rank}`} НХЛ ПО ${metric}`,p.teamValue!==null&&p.teamValue!==undefined?fmtMetric(p.teamValue,p.meta):marketSub(m),99,"место в НХЛ");
  if(n(p.opponentRank)!==null&&p.opponent){
    const opp=Math.round(p.opponentRank),gap=Math.abs(opp-rank);
    put(out,"rank_contrast","rank_contrast",`${p.team} — №${rank}, ${p.opponent} — №${opp} ПО ${metric}`,`РАЗНИЦА ${gap} МЕСТ`,gap>=10?100:92,"контраст соперников");
    if(gap>=8)put(out,"rank_gap","rank_gap",`${p.team} НА ${gap} МЕСТ ВЫШЕ ${p.opponent} ПО ${metric}`,`№${rank} ПРОТИВ №${opp}`,97,"разница мест");
  }
}
function addWindows(out,e,m){
  const ws=(Array.isArray(e.trend_windows)?e.trend_windows:[]).map(w=>({window:n(w.window),hits:n(w.hits),dec:n(w.decisions),rate:n(w.hit_rate),push:n(w.pushes)||0}))
    .filter(w=>w.window&&w.hits!==null&&w.dec).sort((a,b)=>a.window-b.window);
  if(ws.length<2)return;
  const label=marketLabel(m),a=ws[0],b=ws[1];
  put(out,"window_compare","multi_window",`${label}: ${a.hits}/${a.dec} ЗА ${a.window} И ${b.hits}/${b.dec} ЗА ${b.window}`,"ОДНА И ТА ЖЕ ЛИНИЯ",98,"подтверждение на двух окнах");
  const stable=ws.filter(w=>w.rate!==null&&w.rate>=.60);
  if(stable.length>=2){const floor=Math.min(...stable.map(w=>Math.round(w.rate*100)));put(out,"window_stable","stability",`${label} — НЕ НИЖЕ ${floor}% НА ${stable[0].window} И ${stable[1].window} МАТЧАХ`,"УСТОЙЧИВОСТЬ СИГНАЛА",96,"стабильность линии");}
}
function addPlayer(out,e,m){
  if(!String(m.type||"").startsWith("player_"))return;
  const name=String(m.player_name||"ИГРОК").toUpperCase(),hits=n(e.hits),games=n(e.games??e.sample),rate=n(e.hit_rate);
  if(hits!==null&&games!==null)put(out,"player_form","player_form",`${name} — ${Math.round(hits)} ИЗ ${Math.round(games)} ПО ЛИНИИ ${line(m.line)}`,playerStat(m.type),98,"частота индивидуальной линии");
  if(rate!==null&&e.opponent)put(out,"player_h2h","player_h2h",`${name} — ${Math.round(rate*100)}% ПРОХОДА ПРОТИВ ${String(e.opponent).toUpperCase()}`,marketLabel(m),94,"история против соперника");
}
function addSpecial(out,e,m){
  const team=String(e.team||m.subject||"").toUpperCase(),opp=String(e.opponent||"").toUpperCase(),pp=n(e.pp_pct),pk=n(e.opponent_pk_pct),sample=n(e.sample);
  if(team&&pp!==null)put(out,"pp","special_teams_pp",`${team} — ${Math.round(pp*100)}% В БОЛЬШИНСТВЕ`,sample?`ПОСЛЕДНИЕ ${Math.round(sample)} МАТЧЕЙ`:"",97,"реальная реализация большинства");
  if(opp&&pk!==null)put(out,"pk","special_teams_pk",`${opp} — ${Math.round(pk*100)}% В МЕНЬШИНСТВЕ`,team?`КОНТЕКСТ ДЛЯ АТАКИ ${team}`:"",91,"реальный PK соперника");
}
function addLive(out,e,m){
  const mins=n(e.minutes),counts=e.shots_by_team&&typeof e.shots_by_team==="object"?Object.entries(e.shots_by_team).sort((a,b)=>Number(b[1])-Number(a[1])):[];
  if(counts.length>=2)put(out,"live_pressure","live_pressure",`${String(counts[0][0]).toUpperCase()} — ${counts[0][1]}:${counts[1][1]} ПО БРОСКАМ ЗА ${Math.round(mins||10)} МИНУТ`,marketLabel(m),100,"текущее бросковое давление");
  const ps=n(e.shots_in_period),p=n(e.period);
  if(ps!==null&&p!==null)put(out,"period_pace","live_period",`${Math.round(p)}-Й ПЕРИОД — ${Math.round(ps)} БРОСКОВ В СТВОР`,marketLabel(m),95,"темп текущего периода");
}
function addScoreState(out,e,m){
  const hits=n(e.hits),sample=n(e.sample),team=String(e.team||m.subject||"").toUpperCase(),role=String(e.role||"");
  if(!team||hits===null||sample===null)return;
  if(role.includes("comeback"))put(out,"comeback","score_state",`${team} ОТЫГРАЛСЯ В ${Math.round(hits)} ИЗ ${Math.round(sample)} ТАКИХ МАТЧЕЙ`,"УСТУПАЛ ПОСЛЕ 2-ГО ПЕРИОДА",93,"история камбэков");
  if(role.includes("protect"))put(out,"protect","score_state",`${team} УДЕРЖАЛ ПОБЕДУ В ${Math.round(hits)} ИЗ ${Math.round(sample)} ТАКИХ МАТЧЕЙ`,"ВЁЛ ПОСЛЕ 2-ГО ПЕРИОДА",93,"история удержания лидерства");
}
function addSupport(out,e,m){
  const support=Array.isArray(e.supporting_signals)?e.supporting_signals:[],ind=Math.max(Number(e.independent_support_count||0),support.length,Number(e.combination_support_count||0)-1);
  if(ind>=1)put(out,"support","multi_signal_support",`${marketLabel(m)} ПОДТВЕРЖДАЮТ ${ind+1} НЕЗАВИСИМЫХ СИГНАЛА`,"РАЗНЫЕ СТАТИСТИЧЕСКИЕ СЛОИ",88+Math.min(8,ind*2),"несколько независимых подтверждений");
}
function ensureNumber(title,card,p){
  if(/\d/.test(title))return title;
  const e=card.evidence||{},m=card.market||{};
  if(n(p?.teamRank)!==null)return `${title} — №${Math.round(p.teamRank)}`;
  if(n(e.hits)!==null&&n(e.decisions??e.sample??e.games)!==null)return `${title} — ${Math.round(e.hits)} ИЗ ${Math.round(e.decisions??e.sample??e.games)}`;
  if(n(e.hit_rate)!==null)return `${title} — ${Math.round(e.hit_rate*100)}%`;
  if(n(m.line)!==null)return `${title} — ЛИНИЯ ${line(m.line)}`;
  if(n(e.window)!==null)return `${title} — ${Math.round(e.window)} МАТЧЕЙ`;
  return title;
}
function marketLabel(m){
  if(m?.label)return String(m.label).toUpperCase();
  const t=String(m?.type||""),s=String(m?.subject||"").toUpperCase(),side=String(m?.side||"").toLowerCase(),l=n(m?.line),p=period(m?.period);
  if(t==="moneyline")return `${p}ПОБЕДА ${s}`.trim();
  if(t==="handicap")return `${p}${s} ФОРА ${signed(l)}`.trim();
  if(t==="game_total")return `${p}${side==="over"?"ТБ":"ТМ"} ${line(l)}`.trim();
  if(t==="team_total")return `${p}${s} ${side==="over"?"ИТБ":"ИТМ"} ${line(l)}`.trim();
  if(t==="double_chance")return side==="no_draw"?"12 — БЕЗ НИЧЬЕЙ":`${s} ИЛИ НИЧЬЯ`;
  if(t==="both_teams_score")return side==="yes"?"ОБЕ ЗАБЬЮТ — ДА":"ОБЕ ЗАБЬЮТ — НЕТ";
  if(t==="first_goal_team")return `ПЕРВЫЙ ГОЛ — ${s}`;
  if(t==="next_goal_team")return `СЛЕДУЮЩИЙ ГОЛ — ${s}`;
  if(t.startsWith("player_"))return `${playerStat(t)} ${line(l)}`;
  return [p,t,s,side,l===null?"":line(l)].filter(Boolean).join(" ").toUpperCase();
}
function marketSub(m){const o=n(m?.odds);return o!==null&&m?.odds_is_demo!==true?`${marketLabel(m)} · ${o.toFixed(2)}`:marketLabel(m)}
function playerStat(t){return t==="player_shots"?"БРОСКИ":t==="player_assists"?"ПЕРЕДАЧИ":t==="player_points"?"ОЧКИ":t==="player_goals"?"ГОЛЫ":t==="player_hits"?"ХИТЫ":t==="player_blocks"?"БЛОКИ":"ЛИНИЯ ИГРОКА"}
function fmtMetric(v,meta){const x=n(v);if(x===null)return"";const s=fmt(x);return meta?.unit?`${s} ${meta.unit}`:s}
function score(x,card){let s=Number(x.score||50);if(/\d/.test(x.title))s+=6;else s-=14;if(x.title.length<=72)s+=5;else if(x.title.length>96)s-=7;if(card?.market?.odds_is_demo===false)s+=2;if(x.family==="source_fact")s-=8;return s}
function put(out,id,family,title,subtitle,score,reason){if(title)out.push({id,family,title,subtitle:subtitle||null,score,reason})}
function unique(xs){const seen=new Set();return xs.filter(x=>{const k=String(x.title||"");if(!k||seen.has(k))return false;seen.add(k);return true})}
function cleanSource(v){return String(v||"").replace(/\s+/g," ").replace(/\s+([,:])/g,"$1").trim()}
function clean(v){return String(v||"").replace(/\s+/g," ").replace(/\s+([,:])/g,"$1").trim().toUpperCase()}
function titleShape(v){return String(v||"").replace(/\d+(?:[.,]\d+)?/g,"#").replace(/\s+/g," ").trim()}
function period(v){const p=String(v||"GAME").toUpperCase();return p==="P1"?"1-Й ПЕРИОД · ":p==="P2"?"2-Й ПЕРИОД · ":p==="P3"?"3-Й ПЕРИОД · ":p==="REG"?"60 МИН · ":""}
function signed(v){const x=n(v);if(x===null)return"";return(x>0?"+":"")+line(x)}
function line(v){const x=n(v);if(x===null)return"";return(Number.isInteger(x)?String(x):String(Math.round(x*100)/100)).replace(".",",")}
function fmt(v){const x=Number(v),a=Math.abs(x),d=a>=100?0:a>=10?1:2;return x.toFixed(d).replace(".",",")}
function n(v){if(v===null||v===undefined||v==="")return null;const x=Number(v);return Number.isFinite(x)?x:null}
