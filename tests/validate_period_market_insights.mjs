import { strict as assert } from "node:assert";
import { buildPeriodMarketInsightsForRows } from "../cloudflare-worker/src/feature-market-insights.js";

const game={game_pk:99,season_id:"20252026",away_tri:"COL",home_tri:"LAK"};
function row(pk,team,p1,p2,p3){
  return {
    game_pk:pk,team_tri:team,final_goals_for:3,final_goals_against:2,total_goals:5,final_goal_diff:1,final_win:1,
    first_goal_for:1,is_home:team==="LAK"?1:0,is_back_to_back:0,
    p1_goals_for:p1,p1_goals_against:1,p2_goals_for:p2,p2_goals_against:1,p3_goals_for:p3,p3_goals_against:1,
    corsi_for_pct:52,fenwick_for_pct:52,shot_share_pct:52,
  };
}
const away=Array.from({length:10},(_,i)=>row(100+i,"COL",1,1,1));
const home=Array.from({length:10},(_,i)=>row(200+i,"LAK",1,1,1));
const cards=buildPeriodMarketInsightsForRows(game,away,home);
for(const p of [1,2,3]){
  const c=cards.find(x=>x.market?.type==="game_total"&&x.market?.period===`P${p}`&&x.market?.line===1.5&&x.market?.side==="over");
  assert.ok(c,`P${p} total over 1.5 must be generated`);
  assert.equal(c.evidence.sample,20);
  assert.match(c.title,/20 РЕЛЕВАНТНЫХ МАТЧЕЙ/);
}
const p3=cards.find(x=>x.market?.type==="period_3_result");
assert.ok(p3,"third-period result signal must be supported");
console.log("PERIOD_MARKET_INSIGHTS_OK");
