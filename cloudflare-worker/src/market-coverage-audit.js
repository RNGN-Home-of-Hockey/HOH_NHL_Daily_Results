
// Diagnostics for market-first broadcast generation.
// This is operational metadata only; it does not affect ranking or publication.

export function summarizeMarketCoverage(providerMarkets=[],cards=[]){
  const markets=(providerMarkets||[]).filter(Boolean);
  const list=(cards||[]).filter(Boolean);

  const providerKeys=new Map();
  for(const m of markets){
    const k=marketKey(m);
    if(!providerKeys.has(k))providerKeys.set(k,m);
  }

  const cardsByKey=new Map();
  for(const card of list){
    const m=card?.market||{};
    if(m?.odds_is_demo!==false||String(m?.odds_source||"")!=="provider_live")continue;
    const k=marketKey(m);
    if(!cardsByKey.has(k))cardsByKey.set(k,[]);
    cardsByKey.get(k).push(card);
  }

  const familyCounts={};
  const coveredFamilyCounts={};
  for(const m of providerKeys.values()){
    const t=marketType(m);
    familyCounts[t]=(familyCounts[t]||0)+1;
    const k=marketKey(m);
    if(cardsByKey.has(k))coveredFamilyCounts[t]=(coveredFamilyCounts[t]||0)+1;
  }

  const uncovered=[];
  for(const [k,m] of providerKeys){
    if(cardsByKey.has(k))continue;
    uncovered.push({
      key:k,
      type:marketType(m),
      period:String(m.period||"GAME"),
      subject:m.subject??null,
      side:m.side??null,
      line:finite(m.line),
      odds:finite(m.odds),
    });
  }

  const covered=cardsByKey.size;
  const total=providerKeys.size;
  const multi=[...cardsByKey.values()].filter(xs=>xs.length>=2).length;
  const comboCards=list.filter(c=>c?.evidence?.market_combination===true);
  const narrativeVariants=list.reduce((n,c)=>n+(Array.isArray(c?.broadcast_variants)?c.broadcast_variants.length:0),0);

  return {
    provider_selection_count:markets.length,
    provider_exact_market_count:total,
    covered_exact_market_count:covered,
    exact_market_coverage_pct:total?round1(100*covered/total):null,
    multi_signal_market_count:multi,
    multi_signal_coverage_pct:total?round1(100*multi/total):null,
    priced_card_count:[...cardsByKey.values()].reduce((n,xs)=>n+xs.length,0),
    combination_card_count:comboCards.length,
    broadcast_variant_count:narrativeVariants,
    provider_family_counts:sortObject(familyCounts),
    covered_family_counts:sortObject(coveredFamilyCounts),
    uncovered_markets:uncovered.slice(0,80),
  };
}

function marketType(m){
  return String(m?.market_type||m?.type||"unknown");
}
function marketKey(m){
  const type=marketType(m);
  const period=String(m?.period||"GAME");
  const subject=String(m?.subject??"all");
  const side=String(m?.side??"none");
  const line=finite(m?.line);
  return [type,period,subject,side,line===null?"none":line.toFixed(2)].join(":");
}
function finite(v){
  if(v===null||v===undefined||v==="")return null;
  const n=Number(v);return Number.isFinite(n)?n:null;
}
function round1(v){return Math.round(Number(v)*10)/10}
function sortObject(obj){
  return Object.fromEntries(Object.entries(obj).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
}
