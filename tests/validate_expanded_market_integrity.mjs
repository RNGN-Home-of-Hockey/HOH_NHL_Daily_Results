import { strict as assert } from "node:assert";
import { buildExpandedMarketInsights } from "../cloudflare-worker/src/expanded-market-insights.js";

const preparedSql=[];
class Statement{
  constructor(sql){this.sql=sql;this.args=[]}
  bind(...args){this.args=args;return this}
}
const rowsFor=(team)=>Array.from({length:20},(_,i)=>({
  game_pk:1000+(team==="AAA"?i:100+i),
  team_tri:team,
  opponent_tri:team==="AAA"?"BBB":"AAA",
  is_home:i%2,
  final_goals_for:3,
  final_goals_against:2,
  total_goals:5,
  final_goal_diff:1,
  final_win:1,
  regulation_result:"W",
  regulation_goal_diff:1,
  p1_goals_for:1,p1_goals_against:1,
  p2_goals_for:1,p2_goals_against:0,
  p3_goals_for:1,p3_goals_against:1,
  score_after_p1_diff:0,score_after_p2_diff:1,first_goal_for:1,
}));
const db={
  prepare(sql){preparedSql.push(sql);return new Statement(sql)},
  async batch(stmts){
    return stmts.map(s=>({results:rowsFor(String(s.args[0]))}));
  }
};
const game={game_pk:9999,away_tri:"AAA",home_tri:"BBB",scheduled_start_utc:"2026-09-30T00:00:00Z"};
const cards=await buildExpandedMarketInsights(db,game);
assert.ok(cards.length>0);
assert.ok(preparedSql.every(sql=>sql.includes("JOIN team_game_stats own")&&sql.includes("JOIN team_game_stats opp")));
assert.ok(preparedSql.every(sql=>sql.includes("game_events")&&sql.includes("FINAL")&&sql.includes("OFF")));
assert.ok(cards.filter(c=>c.category==="expanded_market").every(c=>
  c.evidence?.final_data_verified===true &&
  c.evidence?.stats_validation==="final_feature_v3_games_team_stats_goal_events"
));
assert.ok(cards.some(c=>c.market?.type==="both_teams_score"&&c.market?.side==="yes"));
assert.ok(!cards.some(c=>c.market?.type==="both_teams_score"&&c.market?.side==="no"));
assert.ok(cards.every(c=>!/(^|[^А-ЯA-Z0-9])(ТМ|ТБ|P1|P2|P3)([^А-ЯA-Z0-9]|$)/i.test(String(c.title||""))));
assert.ok(cards.every(c=>!/(^|[^А-ЯA-Z0-9])(ТМ|ТБ|P1|P2|P3)([^А-ЯA-Z0-9]|$)/i.test(String(c.market?.label||""))));
console.log("EXPANDED_MARKET_INTEGRITY_OK");
