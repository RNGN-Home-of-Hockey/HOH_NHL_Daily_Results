
import { strict as assert } from "node:assert";
import { evaluateProviderMarketHistoryRows } from "../cloudflare-worker/src/provider-market-history-insights.js";

const now="2026-09-23T06:20:00.000Z";
const game={game_pk:2026020999,away_tri:"FLA",home_tri:"CAR"};

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
    regulation_goals_for:diff>0?3:2,regulation_goals_against:diff>0?2:3,
    regulation_goal_diff:diff>0?1:-1,regulation_result:i===7?"T":diff>0?"W":"L",
    p1_goals_for:p1gf,p1_goals_against:p1ga,
    p2_goals_for:2,p2_goals_against:1,p3_goals_for:1,p3_goals_against:1,
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
assert.ok(cards.some(c=>c.market.type==="game_total"&&c.market.period==="P2"&&c.market.line===1.5),"period total should use exact offered line");
assert.ok(cards.some(c=>c.market.type==="double_chance"&&c.market.subject==="CAR"),"double chance should use regulation non-loss history");
assert.ok(cards.some(c=>c.market.type==="both_teams_score"&&c.market.side==="yes"),"BTTS should be evaluated from scoring distribution");
assert.ok(cards.every(c=>c.evidence?.exact_provider_line===true),"every card must be marked exact provider line");
console.log("PROVIDER_MARKET_HISTORY_OK");
