import { strict as assert } from "node:assert";
import { evaluateUniversalMarketRows } from "../cloudflare-worker/src/universal-market-evaluator.js";
import { applyTeamGrammar, lastGamesPhrase } from "../cloudflare-worker/src/team-russian-grammar.js";

const game={game_pk:2026020001,away_tri:"CAR",home_tri:"BOS",scheduled_start_utc:"2026-10-01T00:00:00Z"};
const cards=evaluateUniversalMarketRows(game,{CAR:rows(83,"CAR"),BOS:rows(83,"BOS")});
const handicap=cards.find(c=>c.market?.type==="handicap"&&c.market?.subject==="CAR"&&Number(c.market?.line)===1.5);
assert.ok(handicap,"CAR +1.5 handicap card missing");
assert.equal(Number(handicap.evidence?.window),83);
assert.equal(Number(handicap.evidence?.cover?.current_streak),83);
assert.match(handicap.title,/CAR закрыла фору \+1\.5 в 83 матчах подряд/i);
assert.equal(applyTeamGrammar("CAR закрыл фору +1.5"),"CAR закрыла фору +1.5");
assert.equal(applyTeamGrammar("NYR закрыл фору +1.5"),"NYR закрыли фору +1.5");
assert.equal(applyTeamGrammar("BOS закрыл фору +1.5"),"BOS закрыл фору +1.5");
assert.equal(applyTeamGrammar("FLA пропускал первым"),"FLA пропускала первой");
assert.equal(lastGamesPhrase(21),"последнего 21 матча");
assert.equal(lastGamesPhrase(40),"последних 40 матчей");
console.log("UNIVERSAL_MARKET_LONG_STREAK_AND_GRAMMAR_OK");

function rows(n,team){
  return Array.from({length:n},(_,i)=>({
    game_pk:2025000000+i,scheduled_start_utc:new Date(Date.UTC(2026,8,30-i)).toISOString(),
    opponent_tri:team==="CAR"?"BOS":"CAR",is_home:i%2,
    final_goals_for:3,final_goals_against:2,total_goals:5,final_goal_diff:1,final_win:1,
    regulation_goals_for:3,regulation_goals_against:2,
    p1_goals_for:1,p1_goals_against:0,p2_goals_for:1,p2_goals_against:1,p3_goals_for:1,p3_goals_against:1,
    shots_for:30,shots_against:27,corsi_for_pct:52,fenwick_for_pct:52,rest_days:2,is_back_to_back:0,
  }));
}
