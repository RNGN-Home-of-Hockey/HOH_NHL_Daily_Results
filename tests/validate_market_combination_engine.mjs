
import { strict as assert } from "node:assert";
import { buildMarketCombinationInsights } from "../cloudflare-worker/src/market-combination-engine.js";
import { normalizeWinlineMarket } from "../cloudflare-worker/src/winline-market-adapter.js";

const now="2026-09-23T04:50:00.000Z";
const game={game_pk:2026020001,away_tri:"FLA",home_tri:"CAR"};
const insights=[
  {
    id:"advanced-car",category:"advanced_market",score:94,
    title:"CAR №2 NHL xG differential",
    evidence:{team:"CAR",opponent:"FLA",metric:"xgd60",team_rank:2,opponent_rank:18,rank_gap:16,sample:82,advanced_snapshot:true},
    market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,label:"Победа CAR"}
  },
  {
    id:"venue-car",category:"venue_split",score:88,
    title:"CAR strong home form",evidence:{team:"CAR",sample:10,hit_rate:.8},
    market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,label:"Победа CAR"}
  },
  {
    id:"tt-car",category:"feature",score:86,
    title:"CAR scored 3+ in 8/10",evidence:{team:"CAR",sample:10,hit_rate:.8},
    market:{type:"team_total",period:"GAME",subject:"CAR",side:"over",line:2.5,label:"CAR ТБ 2.5"}
  }
];
const markets=[
  {provider:"winline",market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.79,status:"open",updated_at:now},
  {provider:"winline",market_type:"handicap",period:"GAME",subject:"CAR",side:"CAR",line:-1.5,odds:2.65,status:"open",updated_at:now},
  {provider:"winline",market_type:"team_total",period:"GAME",subject:"CAR",side:"over",line:3.5,odds:2.08,status:"open",updated_at:now}
];
const cards=buildMarketCombinationInsights(insights,markets,game,{now,market_max_age_ms:3600000});
assert.ok(cards.length>=5,"market-first engine should create multiple candidates");
assert.ok(cards.some(c=>c.market.type==="moneyline"&&c.market.odds===1.79));
assert.ok(cards.some(c=>c.market.type==="handicap"&&c.market.line===-1.5));
assert.ok(cards.some(c=>c.market.type==="team_total"&&c.market.line===3.5));
assert.ok(cards.some(c=>c.evidence?.combination_support_count===2),"independent evidence pairs should be created");
assert.ok(cards.every(c=>c.market.odds_is_demo===false&&c.market.odds_source==="provider_live"));

const first=normalizeWinlineMarket({provider:"winline",market_type:"first_goal_team",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.92,status:"open",updated_at:now});
assert.equal(first.market_type,"first_goal_team");
assert.equal(first.line,null);
console.log("MARKET_COMBINATION_ENGINE_OK");
