
import { strict as assert } from "node:assert";
import { summarizeMarketCoverage } from "../cloudflare-worker/src/market-coverage-audit.js";

const markets=[
  {market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.80},
  {market_type:"team_total",period:"GAME",subject:"CAR",side:"over",line:3.5,odds:2.05},
  {market_type:"game_total",period:"GAME",subject:null,side:"over",line:6.5,odds:1.92},
];
const cards=[
  {market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.80,odds_is_demo:false,odds_source:"provider_live"},broadcast_variants:["a","b"],evidence:{market_combination:true}},
  {market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.80,odds_is_demo:false,odds_source:"provider_live"},broadcast_variants:["c"],evidence:{}},
  {market:{type:"team_total",period:"GAME",subject:"CAR",side:"over",line:3.5,odds:2.05,odds_is_demo:false,odds_source:"provider_live"},broadcast_variants:["d","e","f"],evidence:{market_combination:true}},
];
const s=summarizeMarketCoverage(markets,cards);
assert.equal(s.provider_exact_market_count,3);
assert.equal(s.covered_exact_market_count,2);
assert.equal(s.exact_market_coverage_pct,66.7);
assert.equal(s.multi_signal_market_count,1);
assert.equal(s.priced_card_count,3);
assert.equal(s.combination_card_count,2);
assert.equal(s.broadcast_variant_count,6);
assert.equal(s.uncovered_markets.length,1);
assert.equal(s.uncovered_markets[0].type,"game_total");
console.log("MARKET_COVERAGE_AUDIT_OK");
