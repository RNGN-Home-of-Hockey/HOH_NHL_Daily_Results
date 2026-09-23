import { strict as assert } from "node:assert";
import { annotateAirUtility, resolveContradictoryAdvice } from "../cloudflare-worker/src/betting-insight-engine.js";

const real={odds_is_demo:false,odds_source:"provider_live"};
const neutralCheap=annotateAirUtility({
  score:100,category:"h2h_market",title:"P1 PERIOD_1_RESULT NYR — 3 ИЗ 6",
  evidence:{split:"h2h",hits:3,sample:6,decisions:6,hit_rate:.5,window:6},
  market:{type:"period_1_result",period:"P1",subject:"NYR",side:"NYR",odds:1.96,label:"P1 PERIOD_1_RESULT NYR",...real}
});
const neutralValue=annotateAirUtility({
  score:100,category:"h2h_market",title:"P1 PERIOD_1_RESULT NYR — 3 ИЗ 6",
  evidence:{split:"h2h",hits:3,sample:6,decisions:6,hit_rate:.5,window:6},
  market:{type:"period_1_result",period:"P1",subject:"NYR",side:"NYR",odds:3.00,label:"P1 PERIOD_1_RESULT NYR",...real}
});
assert.ok(neutralCheap.air_score<55,"3/6 around even-money must not look like a strong find");
assert.ok(neutralValue.air_score>neutralCheap.air_score,"3/6 at 3.00 may be more interesting by price");
assert.ok(neutralValue.air_score<=68,"tiny 3/6 sample must have a hard quality ceiling");
assert.ok(!/PERIOD_1_RESULT|P1\s*·?\s*PERIOD/i.test(neutralValue.broadcast_title),"period machine key must never leak to TV");
assert.match(neutralValue.broadcast_title,/1-Й ПЕРИОД/);
assert.match(neutralValue.broadcast_title,/3 ИЗ 6/);
assert.equal(neutralValue.air_meta.score_ceiling,68);

const strong=annotateAirUtility({
  score:100,title:"BOS закрыл фору 0 в 59 из 80",
  evidence:{sample:80,hits:59,hit_rate:59/80,multi_window_confirmed:true,independent_support_count:1},
  market:{type:"handicap",period:"GAME",subject:"BOS",side:"BOS",line:0,odds:1.75,...real}
});
assert.ok(strong.air_score>neutralValue.air_score,"large-sample priced signal must outrank tiny sample");
assert.ok(strong.air_score<100,"ordinary strong signal must not saturate at 100");

const exceptional=annotateAirUtility({
  score:100,title:"BOS выиграл 64 из 80",
  evidence:{sample:80,hits:64,hit_rate:.80,multi_window_confirmed:true,independent_support_count:2},
  market:{type:"moneyline",period:"GAME",subject:"BOS",side:"BOS",odds:2.00,...real}
});
assert.equal(exceptional.air_meta.exceptional_match,true);
assert.equal(exceptional.air_score,100,"100 is reserved for exceptional large-sample + price + confirmation alignment");

const resolved=resolveContradictoryAdvice([
  {id:"nyr0",air_score:78,market:{type:"handicap",period:"GAME",subject:"NYR",side:"NYR",line:0}},
  {id:"bos0",air_score:72,market:{type:"handicap",period:"GAME",subject:"BOS",side:"BOS",line:0}},
  {id:"over",air_score:74,market:{type:"game_total",period:"GAME",side:"over",line:5.5}},
  {id:"under",air_score:69,market:{type:"game_total",period:"GAME",side:"under",line:5.5}}
]);
assert.ok(resolved.some(x=>x.id==="nyr0"));
assert.ok(!resolved.some(x=>x.id==="bos0"),"opposite zero-handicap advice must be suppressed");
assert.ok(resolved.some(x=>x.id==="over"));
assert.ok(!resolved.some(x=>x.id==="under"),"opposite total direction on same exact line must be suppressed");
console.log("BROADCAST_VALUE_SCORE_V2_OK",JSON.stringify({neutralCheap:neutralCheap.air_score,neutralValue:neutralValue.air_score,strong:strong.air_score,exceptional:exceptional.air_score}));
