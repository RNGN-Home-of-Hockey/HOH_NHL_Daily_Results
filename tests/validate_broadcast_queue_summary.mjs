import { strict as assert } from 'node:assert';
import { summarizeBroadcastQueueCards } from '../cloudflare-worker/src/broadcast-dashboard-v2.js';

const cards=[
  {air_score:86,market:{odds:1.76,odds_is_demo:false,odds_source:'provider_live'}},
  {air_score:72,market:{odds:2.05,odds_is_demo:false,odds_source:'provider_live'}},
  {air_score:54,market:{odds:1.88,odds_is_demo:false,odds_source:'provider_live'}},
  {air_score:92,market:{odds:null,odds_is_demo:false,odds_source:'unavailable'}},
];
const s=summarizeBroadcastQueueCards(cards);
assert.deepEqual(s,{strong_count:2,priced_count:3,total_count:4,top_air_score:86});
console.log('BROADCAST_QUEUE_SUMMARY_OK',JSON.stringify(s));
