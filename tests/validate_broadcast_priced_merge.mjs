import { strict as assert } from "node:assert";
import { mergeBroadcastInsights } from "../cloudflare-worker/src/broadcast-dashboard-v2.js";

const statistical=[
  {id:"generic-25",title:"generic 2.5",market:{type:"team_total",period:"GAME",subject:"COL",side:"over",line:2.5,odds:1.8,odds_is_demo:true}},
  {id:"history-35",title:"old history 3.5",market:{type:"team_total",period:"GAME",subject:"COL",side:"over",line:3.5,odds:2.0,odds_is_demo:true}},
];
const priced=[
  {id:"advanced-35",title:"COL — №1 НХЛ ПО БРОСКАМ",market:{type:"team_total",period:"GAME",subject:"COL",side:"over",line:3.5,odds:1.87,odds_is_demo:false,odds_source:"provider_live"}}
];

const merged=mergeBroadcastInsights(statistical,priced);
assert.equal(merged[0].id,"advanced-35","real Winline card must be first");
assert.equal(merged[0].market.odds,1.87);
assert.equal(merged.some(x=>x.id==="history-35"),false,"unpriced duplicate exact market must be removed");
assert.equal(merged.some(x=>x.id==="generic-25"),true,"different unpriced market can remain as an alternative");
assert.equal(merged.find(x=>x.id==="generic-25").market.odds,null,"alternative must not retain demo odds");
console.log("BROADCAST_PRICED_MERGE_OK");
