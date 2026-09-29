
import { strict as assert } from "node:assert";
import { evaluateProviderMarketHistoryRows } from "../cloudflare-worker/src/provider-market-history-insights.js";

const now="2026-09-23T06:20:00.000Z";
const game={game_pk:2026020999,season_id:"20262027",away_tri:"FLA",home_tri:"CAR"};

function row(pk,team,i){
  const car=team==="CAR";
  const strong=i<8;
  const total=i===8?6:(strong?7:4); // over 6: 8 wins, 1 push, 1 loss
  const diff=car?(i===8?1:(strong?2:-1)):(i===8?-1:(strong?-2:1));
  const p1diff=car?(i<7?1:i===7?0:-1):(i<7?-1:i===7?0:1);
  const p1gf=p1diff>0?2:p1diff===0?1:0;
  const p1ga=p1diff>0?0:p1diff===0?1:2;
  return {
    game_pk:pk,team_tri:team,opponent_tri:car?"FLA":"CAR",is_home:car?1:0,
    final_goals_for:car?(diff>0?4:2):(diff>0?4:2),
    final_goals_against:car?(diff>0?2:3):(diff>0?2:3),
    total_goals:total,final_goal_diff:diff,final_win:diff>0?1:0,
    regulation_goals_for:p1gf+3,regulation_goals_against:p1ga+2,
    regulation_goal_diff:(p1gf+3)-(p1ga+2),regulation_result:(p1gf+3)>(p1ga+2)?"W":(p1gf+3)<(p1ga+2)?"L":"T",
    p1_goals_for:p1gf,p1_goals_against:p1ga,
    p2_goals_for:2,p2_goals_against:1,p3_goals_for:1,p3_goals_against:1,
    raw_p1_goals_for:p1gf,raw_p1_goals_against:p1ga,
    raw_p2_goals_for:2,raw_p2_goals_against:1,raw_p3_goals_for:1,raw_p3_goals_against:1,
    score_after_p1_diff:p1diff,score_after_p2_diff:p1diff+1,first_goal_for:i<7?1:0,
  };
}
const rowsByTeam={
  CAR:Array.from({length:10},(_,i)=>row(100+i,"CAR",i)),
  FLA:Array.from({length:10},(_,i)=>row(200+i,"FLA",i)),
};
const m=(market_type,period,subject,side,line,odds)=>({
  provider:"winline",market_type,period,subject,side,line,odds,status:"open",updated_at:now
});
const markets=[
  m("game_total","GAME",null,"over",6,1.92),
  m("handicap","GAME","CAR","CAR",-1,1.84),
  m("period_1_result","P1","CAR","CAR",null,2.40),
  m("game_total","P2",null,"over",1.5,1.78),
  m("double_chance","REG","CAR","team_or_draw",null,1.42),
  m("both_teams_score","GAME",null,"yes",null,1.36),
];
const cards=evaluateProviderMarketHistoryRows(game,rowsByTeam,markets);
assert.ok(cards.length>=6,"exact provider evaluator should cover multiple market families");

const total=cards.find(c=>c.market.type==="game_total"&&c.market.period==="GAME"&&c.market.line===6&&c.evidence.window===10);
assert.ok(total,"integer total line must be evaluated directly");
assert.equal(total.evidence.hits,16);
assert.equal(total.evidence.pushes,2);
assert.equal(total.evidence.decisions,18);
assert.match(total.title,/ВОЗВР/);

const handicap=cards.find(c=>c.market.type==="handicap"&&c.market.subject==="CAR"&&c.market.line===-1&&c.evidence.window===10);
assert.ok(handicap,"integer handicap must be evaluated directly");
assert.equal(handicap.evidence.hits,8);
assert.equal(handicap.evidence.pushes,1);
assert.equal(handicap.evidence.decisions,9);

assert.ok(cards.some(c=>c.market.type==="period_1_result"&&c.market.subject==="CAR"),"period 3-way selection should have exact history");
assert.ok(cards.filter(c=>/^P[123]$/.test(String(c.market.period||""))||/^period_[123]_result$/.test(String(c.market.type||""))).every(c=>c.evidence.period_data_verified===true),"period cards require raw period verification");
const corruptPeriodRows={...rowsByTeam,CAR:rowsByTeam.CAR.map((r,i)=>i===0?{...r,raw_p1_goals_for:Number(r.raw_p1_goals_for)+1}:r)};
const corruptPeriodCards=evaluateProviderMarketHistoryRows(game,corruptPeriodRows,[m("period_1_result","P1","CAR","CAR",null,2.40)]);
assert.equal(corruptPeriodCards.length,0,"one mismatched raw period row must suppress the period trend instead of changing the denominator");
assert.ok(cards.some(c=>c.market.type==="game_total"&&c.market.period==="P2"&&c.market.line===1.5),"period total should use exact offered line");
assert.ok(cards.some(c=>c.market.type==="double_chance"&&c.market.subject==="CAR"),"double chance should use regulation non-loss history");
assert.ok(cards.some(c=>c.market.type==="both_teams_score"&&c.market.side==="yes"),"BTTS should be evaluated from scoring distribution");
assert.ok(cards.every(c=>c.evidence?.exact_provider_line===true),"every card must be marked exact provider line");
const seaRows=Array.from({length:40},(_,i)=>({
  game_pk:9000+i,season_id:"20252026",game_type:2,scheduled_start_utc:new Date(Date.UTC(2026,3,30-i)).toISOString(),
  team_tri:"SEA",opponent_tri:"VAN",is_home:i%2,final_goals_for:4,final_goals_against:2,total_goals:6,final_goal_diff:2,final_win:1,
  regulation_goals_for:3,regulation_goals_against:2,regulation_goal_diff:1,regulation_result:"W",
  p1_goals_for:1,p1_goals_against:0,p2_goals_for:1,p2_goals_against:1,p3_goals_for:1,p3_goals_against:1,
  score_after_p1_diff:1,score_after_p2_diff:1,first_goal_for:1,
}));
const seaGame={game_pk:2026021000,season_id:"20262027",away_tri:"SEA",home_tri:"VAN"};
const seaMarket=[m("moneyline","REG","SEA","SEA",null,2.55)];
const seaCards=evaluateProviderMarketHistoryRows(seaGame,{SEA:seaRows,VAN:[]},seaMarket);
const sea=seaCards.find(x=>x.market.type==="moneyline"&&x.market.subject==="SEA");
assert.ok(sea,"SEA exact moneyline history should remain available as historical rate");
assert.equal(sea.evidence.current_streak,0,"previous-season wins must not be called a current streak");
assert.equal(sea.evidence.streak_verified,false);
assert.equal(sea.evidence.stats_validation,"exact_market_v4_raw_period_crosscheck");

const corrupt=Array.from({length:10},(_,i)=>({...seaRows[i],season_id:"20262027"}));
corrupt[0]={...corrupt[0],regulation_goal_diff:-1,regulation_result:"W"};
const corruptCards=evaluateProviderMarketHistoryRows(seaGame,{SEA:corrupt,VAN:[]},seaMarket);
assert.ok(!corruptCards.some(x=>x.evidence?.current_streak>=3),"inconsistent regulation result must break the current streak");
console.log("PROVIDER_MARKET_HISTORY_OK");
