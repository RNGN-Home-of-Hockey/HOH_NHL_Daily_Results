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
assert.equal(p1Result.market_type,"period_1_result");
assert.equal(p1Result.period,"P1");


const bothScore=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:bothteamstoscore:yes",
  market_type:"bothteamstoscore",
  subject_key:"",
  outcome_name:"Yes",
  odds:1.41,
  raw_json:JSON.stringify({freetext:"Both Teams to score",name1:"Yes",odd1:"1.41",name2:"No",odd2:"2.75"}),
  updated_at:now
},event,game,teams);
assert.equal(bothScore.market_type,"both_teams_score");
assert.equal(bothScore.period,"GAME");
assert.equal(bothScore.subject,null);
assert.equal(bothScore.side,"yes");

const p1Insight=[{id:"p1",market:{type:"period_1_result",period:"P1",subject:"TOR",side:"TOR",line:null,label:"1-й период — TOR"}}];
const p1Priced=applyWinlineMarkets(p1Insight,[p1Result],{now,max_age_ms:7*60*60*1000});
assert.equal(p1Priced.length,1);
assert.equal(p1Priced[0].market.odds,2.75);

const doubleChance=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:doublechance:1x",
  market_type:"doublechance",
  subject_key:"",
  outcome_name:"1X",
  odds:1.44,
  raw_json:JSON.stringify({freetext:"Double Chance"}),
  updated_at:now
},event,game,teams);
assert.equal(doubleChance.market_type,"double_chance");
assert.equal(doubleChance.subject,"TOR");
assert.equal(doubleChance.side,"team_or_draw");

const homeOrDraw=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:doublechance:home-draw",
  market_type:"doublechance",
  subject_key:"",
  outcome_name:"Home or Draw",
  odds:1.45,
  raw_json:JSON.stringify({freetext:"Double Chance"}),
  updated_at:now
},event,game,teams);
assert.equal(homeOrDraw.market_type,"double_chance");
assert.equal(homeOrDraw.subject,"TOR");
assert.equal(homeOrDraw.side,"team_or_draw");

const drawOrAway=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:doublechance:draw-away",
  market_type:"doublechance",
  subject_key:"",
  outcome_name:"Draw or Away",
  odds:1.72,
  raw_json:JSON.stringify({freetext:"Double Chance"}),
  updated_at:now
},event,game,teams);
assert.equal(drawOrAway.subject,"MTL");
assert.equal(drawOrAway.side,"team_or_draw");

const homeOrAway=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:doublechance:home-away",
  market_type:"doublechance",
  subject_key:"",
  outcome_name:"Home or Away",
  odds:1.25,
  raw_json:JSON.stringify({freetext:"Double Chance"}),
  updated_at:now
},event,game,teams);
assert.equal(homeOrAway.subject,null);
assert.equal(homeOrAway.side,"no_draw");

const highestPeriod=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:highestperiod:2",
  market_type:"highestperiod",
  subject_key:"TOR",
  outcome_name:"2 Period",
  odds:3.10,
  raw_json:JSON.stringify({freetext:"Highest Scoring Period"}),
  updated_at:now
},event,game,teams);
assert.equal(highestPeriod.market_type,"highest_scoring_period");
assert.equal(highestPeriod.side,"P2");

const teamBucket=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:teamgoals:3plus",
  market_type:"teamgoals",
  subject_key:"TOR",
  outcome_name:"3+",
  odds:1.95,
  raw_json:JSON.stringify({freetext:"Exact Team Goals"}),
  updated_at:now
},event,game,teams);
assert.equal(teamBucket.market_type,"team_goal_bucket");
assert.equal(teamBucket.subject,"TOR");
assert.equal(teamBucket.side,"3_plus");

const combo=canonicalBroadcastWinlineMarket({
  winline_market_id:"16255255:resulttotal:1o55",
  market_type:"resulttotal:5.5",
  subject_key:"TOR",
  outcome_name:"1 Over",
  odds:2.75,
  raw_json:JSON.stringify({freetext:"Result and Total",value:"5.5"}),
  updated_at:now
},event,game,teams);
assert.equal(combo.market_type,"result_total_combo");
assert.equal(combo.subject,"TOR");
assert.equal(combo.side,"over");
assert.equal(combo.line,5.5);

const insight=[{id:"x",market:{type:"handicap",subject:"MTL",side:"MTL",line:1.5,label:"MTL +1.5"}}];
const fresh=applyWinlineMarkets(insight,[mtlPlus],{now,max_age_ms:7*60*60*1000});
assert.equal(fresh.length,1);
assert.equal(fresh[0].market.odds,1.36);
assert.equal(fresh[0].market.odds_source,"provider_live");

const stale=applyWinlineMarkets(insight,[{...mtlPlus,updated_at:"2026-09-19T17:00:35.000Z"}],{now,max_age_ms:7*60*60*1000});
assert.equal(stale.length,0);

console.log("WINLINE_BROADCAST_MAPPING_OK");
