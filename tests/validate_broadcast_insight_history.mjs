import { strict as assert } from "node:assert";
import { evaluateBroadcastInsightOutcome } from "../cloudflare-worker/src/broadcast-insight-history.js";

const game={home_tri:"CAR",away_tri:"FLA",home_score:4,away_score:3,game_state:"FINAL"};
const periods=[
  {period_number:1,home_goals:1,away_goals:0},
  {period_number:2,home_goals:1,away_goals:2},
  {period_number:3,home_goals:1,away_goals:1},
  {period_number:4,home_goals:1,away_goals:0},
];
assert.equal(evaluateBroadcastInsightOutcome({market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR"},game,periods),"win");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"moneyline",period:"REG",subject:"CAR",side:"CAR"},game,periods),"loss");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"moneyline",period:"REG",subject:null,side:"draw"},game,periods),"win");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"handicap",period:"GAME",subject:"CAR",side:"CAR",line:-1.5},game,periods),"loss");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"handicap",period:"GAME",subject:"FLA",side:"FLA",line:1.5},game,periods),"win");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"game_total",period:"GAME",side:"over",line:6.5},game,periods),"win");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"team_total",period:"GAME",subject:"CAR",side:"over",line:3.5},game,periods),"win");
assert.equal(evaluateBroadcastInsightOutcome({market_type:"game_total",period:"P1",side:"under",line:1.5},game,periods),"win");
console.log("BROADCAST_INSIGHT_SETTLEMENT_OK");
