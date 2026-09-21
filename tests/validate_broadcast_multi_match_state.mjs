import { strict as assert } from 'node:assert';
import { handleBroadcastLiveStateRequest } from '../cloudflare-worker/src/broadcast-live-state.js';
import { handleBroadcastOperatorRequest } from '../cloudflare-worker/src/broadcast-operator.js';

const rows=[
  {card_id:'a',game_pk:2026020001,headline_ru:'A',stat_text_ru:'A',status:'shown',shown_at:'2026-09-21T17:00:00Z'},
  {card_id:'b',game_pk:2026020002,headline_ru:'B',stat_text_ru:'B',status:'shown',shown_at:'2026-09-21T17:00:01Z'},
];
const DB={prepare(sql){return{
  bind(gamePk){return{async first(){return rows.find(x=>Number(x.game_pk)===Number(gamePk))||null}}},
  async first(){return rows[1]},
}}};
const env={DB};

for(const row of rows){
  const request=new Request('https://example.test/api/broadcast/state?game='+row.game_pk);
  const response=await handleBroadcastLiveStateRequest(request,env,'/api/broadcast/state');
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.on_air.card_id,row.card_id);
  assert.equal(data.scope.game_pk,row.game_pk);
}
const globalResponse=await handleBroadcastLiveStateRequest(
  new Request('https://example.test/api/broadcast/state'),
  env,
  '/api/broadcast/state'
);
assert.equal((await globalResponse.json()).on_air.card_id,'b','legacy global state remains available');

const overlay=await handleBroadcastOperatorRequest(
  new Request('https://example.test/broadcast/overlay?game=2026020001'),
  {},
  '/broadcast/overlay'
);
const html=await overlay.text();
assert.match(html,/overlayGame/);
assert.match(html,/stateUrl/);
assert.match(html,/encodeURIComponent\(overlayGame\)/);

console.log('BROADCAST_MULTI_MATCH_STATE_OK');
