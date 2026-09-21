import { strict as assert } from "node:assert";
import { canonicalBroadcastWinlineMarket } from "../cloudflare-worker/src/broadcast-dashboard-v2.js";
import { applyWinlineMarkets } from "../cloudflare-worker/src/winline-market-adapter.js";

const now="2026-09-21T13:40:00.000Z";
const event={winline_event_id:"16255255",deeplink:"https://winline.ru/plus/16255255",updated_at:now};
const game={game_pk:2026020002,home_tri:"TOR",away_tri:"MTL"};
const teams={team1:"TOR",team2:"MTL"};

const mtlPlus=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:asianhandicap:-1.5:2",
  market_type:"asianhandicap:-1.5",
  subject_key:"MTL",
  outcome_name:"2",
  odds:1.36,
  raw_json:JSON.stringify({freetext:"Asian Handicap",value:"-1.5",name1:"1",odd1:"2.95",name2:"2",odd2:"1.36"}),
  updated_at:now
},event,game,teams);
assert.equal(mtlPlus.market_type,"handicap");
assert.equal(mtlPlus.period,"GAME");
assert.equal(mtlPlus.subject,"MTL");
assert.equal(mtlPlus.side,"MTL");
assert.equal(mtlPlus.line,1.5);
assert.equal(mtlPlus.odds,1.36);

const p1Fora=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:1periodfora:0:1",
  market_type:"1periodfora:0",
  subject_key:"TOR",
  outcome_name:"1",
  odds:1.83,
  raw_json:JSON.stringify({freetext:"1 Period Fora",value:"0",name1:"1",odd1:"1.83",name2:"2",odd2:"1.87"}),
  updated_at:now
},event,game,teams);
assert.equal(p1Fora.market_type,"handicap");
assert.equal(p1Fora.period,"P1");
assert.equal(p1Fora.line,0);

const p1Result=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:1period3wayodds:1",
  market_type:"1period3wayodds",
  subject_key:"TOR",
  outcome_name:"1",
  odds:2.75,
  raw_json:JSON.stringify({freetext:"1 Period 3-way odds",name1:"1",odd1:"2.75",name2:"X",odd2:"2.75",name3:"2",odd3:"2.85"}),
  updated_at:now
},event,game,teams);
assert.equal(p1Result.market_type,"moneyline");
assert.equal(p1Result.period,"P1");

const insight=[{id:"x",market:{type:"handicap",subject:"MTL",side:"MTL",line:1.5,label:"MTL +1.5"}}];
const fresh=applyWinlineMarkets(insight,[mtlPlus],{now,max_age_ms:7*60*60*1000});
assert.equal(fresh.length,1);
assert.equal(fresh[0].market.odds,1.36);
assert.equal(fresh[0].market.odds_source,"provider_live");

const stale=applyWinlineMarkets(insight,[{...mtlPlus,updated_at:"2026-09-19T17:00:35.000Z"}],{now,max_age_ms:7*60*60*1000});
assert.equal(stale.length,0);

console.log("WINLINE_BROADCAST_MAPPING_OK");
