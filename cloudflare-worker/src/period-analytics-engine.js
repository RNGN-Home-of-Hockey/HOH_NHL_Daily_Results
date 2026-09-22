// Period Analytics Engine
// Produces explainable period tendencies for pregame/live usage.

const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v)||0));

export function buildPeriodAnalytics(periods={}){
  const result={model:"period_analytics_v1",periods:{}};
  for(const p of ["1","2","3"]){
    const x=periods[p]||{};
    const games=Number(x.games)||0;
    result.periods[p]={
      sample:games,
      scoring_for:Number(x.goals_for||0),
      scoring_against:Number(x.goals_against||0),
      avg_for:games?Number(x.goals_for||0)/games:0,
      avg_against:games?Number(x.goals_against||0)/games:0,
      tendency:clamp(50+((Number(x.goals_for||0)-Number(x.goals_against||0))*5)),
      late_game_profile:x.comeback_rate||null,
      protect_lead:x.protect_lead_rate||null,
    };
  }
  return result;
}

export function periodMarketSignals(data){
 const out=[];
 for(const [period,v] of Object.entries(data?.periods||{})){
  if(v.tendency>=65) out.push({type:"period_strength",period,title:`${period} период — сильный отрезок`,score:v.tendency});
 }
 return out;
}
