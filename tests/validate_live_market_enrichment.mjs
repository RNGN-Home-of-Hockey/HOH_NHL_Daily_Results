
import { strict as assert } from "node:assert";
import { buildLiveCards, attachLiveWinlineMarkets } from "../cloudflare-worker/src/live-betting-engine.js";

const game={
  game_pk:2026020001,home_tri:"CAR",away_tri:"FLA",home_score:1,away_score:1,
  period_number:2,game_state:"LIVE",seconds_remaining:600,time_remaining:"10:00"
};
const shots=[];
for(let i=0;i<10;i++)shots.push({
  sort_order:i+1,event_type:"shot-on-goal",team_tri:i<8?"CAR":"FLA",
  period_number:2,period_type:"REG",elapsed_seconds:1200+i*30
});
const raw=buildLiveCards(game,shots);
assert.ok(raw.some(c=>c.market?.type==="next_goal_team"&&c.market?.subject==="CAR"),"shot pressure should generate next-goal card");
assert.ok(raw.some(c=>c.market?.type==="moneyline"&&c.market?.subject==="CAR"),"tied score + pressure should generate live moneyline context");

const now=new Date().toISOString();
const provider=[
  {provider:"winline",market_type:"next_goal_team",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.91,status:"open",is_live:true,updated_at:now},
  {provider:"winline",market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.84,status:"open",is_live:true,updated_at:now},
];
const enriched=attachLiveWinlineMarkets({ok:true,game,cards:raw},provider,{now,market_max_age_ms:300000});
assert.ok(enriched.cards.length>=2,"live provider markets should price compatible cards");
assert.ok(enriched.cards.every(c=>c.market.odds_is_demo===false&&c.market.odds_source==="provider_live"));
assert.ok(enriched.cards.some(c=>c.market.type==="next_goal_team"&&c.market.odds===1.91));
assert.ok(enriched.cards.some(c=>c.market.type==="moneyline"&&c.market.odds===1.84));
assert.ok(enriched.cards.every(c=>c.operator_narrative&&Array.isArray(c.broadcast_variants)));
console.log("LIVE_MARKET_ENRICHMENT_OK");
