// Live Analytics Engine
// Runtime momentum layer. Data adapters can feed NHL live events later.

export function buildLiveAnalytics(state={}){
 const shots=Number(state.shots||0);
 const oppShots=Number(state.opponent_shots||0);
 const lastMinutes=Number(state.last_minutes||10);
 const score=Number(state.score||0);
 const oppScore=Number(state.opponent_score||0);
 const pressure=(shots-oppShots)/Math.max(1,lastMinutes);
 const comeback=score<oppScore;
 return {
  model:"live_analytics_v1",
  window_minutes:lastMinutes,
  shot_pressure:pressure,
  shot_advantage:shots-oppShots,
  score_state:score>oppScore?"leading":score<oppScore?"trailing":"tied",
  comeback_state:comeback,
  next_goal_context: pressure>0?"home_pressure":"opponent_pressure"
 };
}
