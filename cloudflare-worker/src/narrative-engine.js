// Narrative Engine v2
// Converts raw analytical evidence into:
// 1) TV copy — short, numerical and understandable for a viewer.
// 2) Operator copy — full metric context for the commentator/operator.
// 3) Variants — alternative editorial angles that can be ranked later.

const METRICS={
  xgd60:{tv:"РАЗНИЦЕ ОПАСНЫХ МОМЕНТОВ",raw:"xG differential / 60",unit:"xG/60"},
  xgf60:{tv:"СОЗДАННЫМ ОПАСНЫМ МОМЕНТАМ",raw:"xGF/60",unit:"xG/60"},
  xga60:{tv:"МИНИМУМУ ДОПУЩЕННЫХ ОПАСНЫХ МОМЕНТОВ",raw:"xGA/60",unit:"xG/60"},
  hdxgf60:{tv:"СОЗДАННЫМ САМЫМ ОПАСНЫМ МОМЕНТАМ",raw:"HD xGF/60",unit:"HD xG/60"},
  hdxga60:{tv:"МИНИМУМУ ДОПУЩЕННЫХ САМЫХ ОПАСНЫХ МОМЕНТОВ",raw:"HD xGA/60",unit:"HD xG/60"},
  sf60:{tv:"БРОСКАМ В СТВОР",raw:"SF/60",unit:"броска/60"},
  sa60:{tv:"МИНИМУМУ ДОПУЩЕННЫХ БРОСКОВ",raw:"SA/60",unit:"броска/60"},
  sd60:{tv:"РАЗНИЦЕ БРОСКОВ",raw:"shot differential / 60",unit:"броска/60"},
  xgf_pct:{tv:"ДОЛЕ ОПАСНЫХ МОМЕНТОВ",raw:"xGF%",unit:"%"},
  xgfpercent:{tv:"ДОЛЕ ОПАСНЫХ МОМЕНТОВ",raw:"xGF%",unit:"%"},
  cf_pct:{tv:"КОНТРОЛЮ БРОСКОВ",raw:"Corsi For %",unit:"%"},
  corsi_pct:{tv:"КОНТРОЛЮ БРОСКОВ",raw:"Corsi For %",unit:"%"},
  fenwick_pct:{tv:"КОНТРОЛЮ НЕЗАБЛОКИРОВАННЫХ БРОСКОВ",raw:"Fenwick For %",unit:"%"},
  shot_share:{tv:"ДОЛЕ БРОСКОВ",raw:"shot share",unit:"%"},
  shotpace60:{tv:"ТЕМПУ БРОСКОВ",raw:"shot pace / 60",unit:"броска/60"},
  xgpace60:{tv:"ТЕМПУ ОПАСНЫХ МОМЕНТОВ",raw:"xG pace / 60",unit:"xG/60"},
  gsax:{tv:"ИГРЕ ВРАТАРЯ ВЫШЕ ОЖИДАНИЙ",raw:"GSAx",unit:"гола"},
  goals_saved_above_expected:{tv:"ИГРЕ ВРАТАРЯ ВЫШЕ ОЖИДАНИЙ",raw:"GSAx",unit:"гола"},
};

export function buildNarrative(card={},context={}){
  const profile=extractProfile(card,context);
  const fallback=String(card.broadcast_title||card.title||card.value||"АНАЛИТИЧЕСКИЙ ФАКТ").trim();
  const variants=buildVariants(profile,card,fallback);
  const title=variants[0]||fallback;
  const operator=buildOperator(profile,card,context);

  return {
    tv:{
      title,
      subtitle:buildTvSubtitle(profile),
      variants,
      generated:Boolean(variants.length),
    },
    operator,
  };
}

function extractProfile(card,context){
  const e=card?.evidence||{};
  const market=card?.market||{};
  const game=context?.game||{};
  const nestedTeam=isObject(e.team)?e.team:null;
  const nestedOpponent=isObject(e.opponent)?e.opponent:null;

  const team=upper(
    market.subject ||
    (!isObject(e.team)?e.team:null) ||
    card.team_tri ||
    ""
  );
  let opponent=upper(!isObject(e.opponent)?e.opponent:"");
  if(!opponent&&team){
    if(upper(game.home_tri)===team)opponent=upper(game.away_tri);
    else if(upper(game.away_tri)===team)opponent=upper(game.home_tri);
  }

  const directMetric=metricKey(e.metric||card?.metric?.name||card?.analytics?.name);
  const nestedPick=pickNestedMetric(nestedTeam,nestedOpponent,card);
  const metric=directMetric||nestedPick.metric||"";
  const meta=metricMeta(metric,card);

  const teamRank=finite(
    e.team_rank ?? e.rank ?? nestedPick.teamRank ??
    nestedTeam?.ranks?.[metric]
  );
  const opponentRank=finite(
    e.opponent_rank ?? nestedPick.opponentRank ??
    nestedOpponent?.ranks?.[opponentMetricKey(e.opponent_metric,metric)]
  );

  const teamValue=finite(
    e.team_value ?? e.value ?? nestedPick.teamValue ??
    nestedTeam?.[metric]
  );
  const opponentValue=finite(
    e.opponent_value ?? nestedPick.opponentValue ??
    nestedOpponent?.[opponentMetricKey(e.opponent_metric,metric)]
  );

  return {
    team,opponent,metric,meta,
    teamRank,opponentRank,teamValue,opponentValue,
    rankGap:finite(e.rank_gap) ?? (
      teamRank!==null&&opponentRank!==null?Math.abs(opponentRank-teamRank):null
    ),
    sample:finite(e.sample_size??e.sample??context.sample??e.window),
    season:String(e.season||""),
    role:String(e.role||e.reason||""),
    rollingTeamRank:finite(e.rolling_team_rank),
    rollingTeamWindow:finite(e.rolling_team_window),
    rollingTeamRank20:finite(e.rolling_team_rank_20),
    rollingTeamRank10:finite(e.rolling_team_rank_10),
    rollingOpponentRank:finite(e.rolling_opponent_rank),
    rollingOpponentWindow:finite(e.rolling_opponent_window),
    rollingOpponentRank20:finite(e.rolling_opponent_rank_20),
    rollingOpponentRank10:finite(e.rolling_opponent_rank_10),
    venueSample:finite(e.venue_sample),
    venueConfirmed:e.venue_confirmed===true,
    multiWindow:e.multi_window_confirmed===true,
    persistent:e.persistent_previous_season===true,
    teamVenue:isObject(e.team_venue)?e.team_venue:null,
    opponentVenue:isObject(e.opponent_venue)?e.opponent_venue:null,
    nestedTeam,nestedOpponent,
  };
}


function buildVariants(p,card,fallback){
  const out=[],market=card?.market||{},ev=card?.evidence||{};
  if(p.team&&p.teamRank!==null&&p.metric){
    out.push(p.team+" — "+rankText(p.teamRank)+" НХЛ ПО "+p.meta.tv);
    if(p.teamValue!==null)out.push(p.team+" — "+rankText(p.teamRank)+" НХЛ ПО "+p.meta.tv+": "+formatValue(p.teamValue,p.meta));
    if(p.opponent&&p.opponentRank!==null&&p.rankGap!==null&&p.rankGap>=8){
      out.push(p.team+" — НА "+Math.round(p.rankGap)+" МЕСТ ВЫШЕ "+p.opponent+" ПО "+p.meta.tv);
      out.push(p.team+" — "+rankText(p.teamRank)+", "+p.opponent+" — №"+Math.round(p.opponentRank)+" ПО "+p.meta.tv);
    }
  }

  const rollingRank=p.rollingTeamRank20??p.rollingTeamRank??p.rollingTeamRank10;
  const rollingWindow=p.rollingTeamRank20!==null?20:(p.rollingTeamWindow??(p.rollingTeamRank10!==null?10:null));
  if(p.team&&rollingRank!==null&&rollingWindow){
    out.push(p.team+" — "+rankText(rollingRank)+" НХЛ ЗА ПОСЛЕДНИЕ "+Math.round(rollingWindow)+" МАТЧЕЙ ПО "+p.meta.tv);
  }
  if(p.team&&p.teamRank!==null&&rollingRank!==null&&rollingWindow){
    out.push(p.team+" — "+rankText(p.teamRank)+" ЗА СЕЗОН И "+rankText(rollingRank)+" ЗА ПОСЛЕДНИЕ "+Math.round(rollingWindow)+" ПО "+p.meta.tv);
  }
  if(p.team&&p.teamRank!==null&&p.persistent)out.push(p.team+" — "+rankText(p.teamRank)+" НХЛ ПО "+p.meta.tv+" ДВА СЕЗОНА ПОДРЯД");
  if(p.team&&p.venueConfirmed&&p.venueSample!==null)out.push(p.team+" ПОДТВЕРЖДАЕТ ПРЕИМУЩЕСТВО ДОМА/В ГОСТЯХ — ВЫБОРКА "+Math.round(p.venueSample)+" МАТЧЕЙ");

  const support=Array.isArray(ev.supporting_signals)?ev.supporting_signals:[];
  for(const item of support.slice(0,4)){
    const t=String(item?.title||item?.eyebrow||"").trim();
    if(t)out.push(t);
    if(p.team&&t)out.push(p.team+" — СИГНАЛ ПОДТВЕРЖДАЮТ 2 НЕЗАВИСИМЫХ ПОКАЗАТЕЛЯ");
  }

  const odds=finite(market.odds);
  if(market.label&&odds!==null&&out.length){
    out.push(out[0]+" · ЛИНИЯ "+String(market.label)+" ЗА "+odds.toFixed(2));
  }

  if(!out.length&&fallback)out.push(fallback);
  return unique(out).slice(0,14);
}

function buildTvSubtitle(p){
  const parts=[];
  if(p.teamValue!==null)parts.push(formatValue(p.teamValue,p.meta));
  if(p.sample!==null)parts.push(`${Math.round(p.sample)} матчей`);
  return parts.length?parts.join(" · "):null;
}

function buildOperator(p,card,context){
  const e=card?.evidence||{};
  const market=card?.market||{};
  const details=[];

  if(p.team&&p.teamRank!==null){
    details.push(`${p.team}: ${Math.round(p.teamRank)}-е место в НХЛ по ${p.meta.raw}${p.teamValue!==null?` — ${formatValue(p.teamValue,p.meta)}`:""}.`);
  }
  if(p.opponent&&p.opponentRank!==null){
    details.push(`${p.opponent}: ${Math.round(p.opponentRank)}-е место по сопоставимому показателю${p.opponentValue!==null?` — ${formatValue(p.opponentValue,p.meta)}`:""}.`);
  }
  if(p.rankGap!==null&&p.teamRank!==null&&p.opponentRank!==null){
    details.push(`Разница в рейтинге: ${Math.round(p.rankGap)} мест.`);
  }

  addRolling(details,p);
  addVenue(details,p);

  if(p.sample!==null)details.push(`База сигнала: ${Math.round(p.sample)} матчей.`);
  if(p.season)details.push(`Сезон данных: ${seasonLabel(p.season)}.`);
  if(p.persistent)details.push("Профиль подтверждается предыдущим сезоном.");
  if(p.multiWindow)details.push("Сезонный профиль и последние матчи дают сигнал в одном направлении.");

  if(market?.label) {
    const odds=finite(market.odds);
    details.push(`Связанная линия: ${String(market.label)}${odds!==null?` · кэф ${odds.toFixed(2)}`:""}.`);
  }
  const supporting=Array.isArray(e.supporting_signals)?e.supporting_signals:[];
  if(supporting.length){
    details.push("Независимых подтверждений: "+supporting.length+".");
    for(const item of supporting.slice(0,4)){
      const title=String(item?.title||item?.eyebrow||item?.category||"").trim();
      if(title)details.push("Подтверждение: "+title+".");
    }
  }
  if(e.market_combination===true){
    details.push("Карточка собрана market-first: сначала взята реальная линия WINLINE, затем к ней подобраны совместимые статистические сигналы.");
  }
  if(card?.explanation)details.push(String(card.explanation));

  const raw={
    metric:p.metric||null,
    metric_name:p.meta.raw,
    team_rank:p.teamRank,
    team_value:p.teamValue,
    opponent_rank:p.opponentRank,
    opponent_value:p.opponentValue,
    rolling_team_rank_20:p.rollingTeamRank20,
    rolling_team_rank_10:p.rollingTeamRank10,
    rolling_opponent_rank_20:p.rollingOpponentRank20,
    rolling_opponent_rank_10:p.rollingOpponentRank10,
    venue_sample:p.venueSample,
    market,
    evidence:e,
  };

  return {
    headline:p.team?`${p.team}: ПОЛНАЯ СТАТИСТИКА ДЛЯ КОММЕНТАТОРА`:"ПОЛНАЯ СТАТИСТИКА ДЛЯ КОММЕНТАТОРА",
    details:unique(details).slice(0,12),
    raw,
  };
}

function addRolling(details,p){
  if(p.rollingTeamRank20!==null||p.rollingTeamRank10!==null){
    const bits=[];
    if(p.rollingTeamRank20!==null)bits.push(`последние 20 — №${Math.round(p.rollingTeamRank20)}`);
    if(p.rollingTeamRank10!==null)bits.push(`последние 10 — №${Math.round(p.rollingTeamRank10)}`);
    details.push(`${p.team}: ${bits.join(", ")} по этому профилю.`);
  }else if(p.rollingTeamRank!==null&&p.rollingTeamWindow!==null){
    details.push(`${p.team}: №${Math.round(p.rollingTeamRank)} за последние ${Math.round(p.rollingTeamWindow)} матчей.`);
  }
  if(p.opponent&&(p.rollingOpponentRank20!==null||p.rollingOpponentRank10!==null)){
    const bits=[];
    if(p.rollingOpponentRank20!==null)bits.push(`последние 20 — №${Math.round(p.rollingOpponentRank20)}`);
    if(p.rollingOpponentRank10!==null)bits.push(`последние 10 — №${Math.round(p.rollingOpponentRank10)}`);
    details.push(`${p.opponent}: ${bits.join(", ")} по сопоставимому профилю.`);
  }
}

function addVenue(details,p){
  if(!p.venueSample&&!p.teamVenue&&!p.opponentVenue)return;
  const prefix=p.venueConfirmed?"Home/away подтверждает сигнал.":"Home/away — дополнительный контекст.";
  const parts=[];
  if(p.venueSample!==null)parts.push(`выборка ${Math.round(p.venueSample)} матчей`);
  if(p.teamVenue?.sample)parts.push(`${p.team}: ${Math.round(Number(p.teamVenue.sample))} игр`);
  if(p.opponentVenue?.sample)parts.push(`${p.opponent}: ${Math.round(Number(p.opponentVenue.sample))} игр`);
  details.push(`${prefix}${parts.length?" "+parts.join(" · ")+".":""}`);
}

function pickNestedMetric(team,opponent,card){
  if(!team?.ranks)return {};
  const keys=["xgf60","xgf_pct","corsi_pct","fenwick_pct","xga60"];
  const ranked=keys
    .map(metric=>({metric,rank:finite(team.ranks?.[metric]),value:finite(team?.[metric])}))
    .filter(x=>x.rank!==null)
    .sort((a,b)=>a.rank-b.rank);
  const best=ranked[0];
  if(!best)return {};
  const oppMetric=best.metric==="xgf60"?"xga60":best.metric;
  return {
    metric:best.metric,
    teamRank:best.rank,
    teamValue:best.value,
    opponentRank:finite(opponent?.ranks?.[oppMetric]),
    opponentValue:finite(opponent?.[oppMetric]),
  };
}

function metricMeta(metric,card){
  const base=METRICS[metric]||{
    tv:humanMetricFromText(metric||card?.title||"АНАЛИТИЧЕСКОМУ ПОКАЗАТЕЛЮ"),
    raw:metric||"advanced metric",
    unit:"",
  };
  const source=(String(card?.title||"")+" "+String(card?.explanation||"")).toLowerCase();
  if(metric==="xgf60"&&source.includes("большинств")){
    return {...base,tv:"СОЗДАННЫМ ОПАСНЫМ МОМЕНТАМ В БОЛЬШИНСТВЕ",raw:"PP xGF/60"};
  }
  return base;
}

function humanMetricFromText(value){
  const s=String(value||"").toLowerCase();
  if(s.includes("xg-дифф")||s.includes("xgd"))return "РАЗНИЦЕ ОПАСНЫХ МОМЕНТОВ";
  if(s.includes("xgf")||s==="xg")return "СОЗДАННЫМ ОПАСНЫМ МОМЕНТАМ";
  if(s.includes("xga"))return "МИНИМУМУ ДОПУЩЕННЫХ ОПАСНЫХ МОМЕНТОВ";
  if(s.includes("corsi"))return "КОНТРОЛЮ БРОСКОВ";
  if(s.includes("fenwick"))return "КОНТРОЛЮ НЕЗАБЛОКИРОВАННЫХ БРОСКОВ";
  if(s.includes("брос"))return "БРОСКАМ";
  return "АНАЛИТИЧЕСКОМУ ПОКАЗАТЕЛЮ";
}

function opponentMetricKey(value,fallback){
  return metricKey(value)||fallback;
}

function metricKey(value){
  const raw=String(value||"").trim().toLowerCase().replace(/[%\s/-]+/g,"_").replace(/^_+|_+$/g,"");
  const aliases={
    "xg_differential":"xgd60",
    "xg_diff":"xgd60",
    "xgd_60":"xgd60",
    "xgf_60":"xgf60",
    "xga_60":"xga60",
    "hd_xgf_60":"hdxgf60",
    "hd_xga_60":"hdxga60",
    "sf_60":"sf60",
    "sa_60":"sa60",
    "sd_60":"sd60",
    "xgf":"xgf_pct",
    "xgf_pct":"xgf_pct",
    "corsi":"corsi_pct",
    "corsi_for_pct":"corsi_pct",
    "cf_pct":"cf_pct",
    "fenwick":"fenwick_pct",
    "fenwick_for_pct":"fenwick_pct",
  };
  return aliases[raw]||raw;
}

function rankText(rank){
  const n=Math.max(1,Math.round(Number(rank)));
  return n<=5?`ТОП-${n}`:`№${n}`;
}

function formatValue(value,meta){
  const n=Number(value);
  if(!Number.isFinite(n))return String(value??"");
  const abs=Math.abs(n);
  const digits=abs>=100?0:abs>=10?1:2;
  const rendered=n.toFixed(digits).replace(".",",");
  return meta?.unit?`${rendered} ${meta.unit}`:rendered;
}

function seasonLabel(value){
  const s=String(value||"");
  if(/^\d{8}$/.test(s))return `${s.slice(0,4)}/${s.slice(6,8)}`;
  return s;
}

function upper(value){return String(value||"").trim().toUpperCase()}
function finite(value){
  if(value===null||value===undefined||value==="")return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}
function isObject(value){return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)}
function unique(values){return [...new Set((values||[]).filter(Boolean))]}
