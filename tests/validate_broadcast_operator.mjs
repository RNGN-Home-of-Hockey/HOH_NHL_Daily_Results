import { strict as assert } from 'node:assert';
import { handleBroadcastOperatorRequest } from '../cloudflare-worker/src/broadcast-operator.js';

const cards = new Map([
  ['test-card', {
    card_id:'test-card',game_pk:2026020001,headline_ru:'Test',stat_text_ru:'60%',source_note_ru:'fixture',
    status:'draft',shown_at:null,manual_odds:null,odds_is_demo:1,
  }],
]);

const db = {
  prepare(sql) { return statement(sql); },
  async batch(statements) {
    const results=[];
    for (const st of statements) results.push(await st.__run());
    return results;
  },
};
const env={DB:db,MANAGEMENT_API_SECRET:'operator-secret'};

let r=await handleBroadcastOperatorRequest(new Request('https://example.test/broadcast/operator'),{},'/broadcast/operator');
assert.equal(r.status,200);assert.match(await r.text(),/BROADCAST OPERATOR/);
r=await handleBroadcastOperatorRequest(new Request('https://example.test/broadcast/overlay'),{},'/broadcast/overlay');
assert.equal(r.status,200);assert.match(await r.text(),/HOME OF HOCKEY × WINLINE/);

r=await callStatus('shown',false);
assert.equal(r.status,401,'operator mutations must reject missing auth');
assert.equal(cards.get('test-card').status,'draft');

r=await callStatus('shown',true);
assert.equal(r.status,409,'SHOW must be rejected before PREVIEW');
assert.equal((await r.json()).error,'preview_required_before_show');
assert.equal(cards.get('test-card').status,'draft');

r=await callStatus('preview',true);
assert.equal(r.status,200);assert.equal(cards.get('test-card').status,'preview');

r=await callStatus('shown',true);
assert.equal(r.status,200);assert.equal(cards.get('test-card').status,'shown');
assert.ok(cards.get('test-card').shown_at,'shown card must receive shown_at');

r=await handleBroadcastOperatorRequest(new Request('https://example.test/api/broadcast/operator/cards/test-card',{
  method:'PATCH',headers:authHeaders(),body:JSON.stringify({headline_ru:'Changed'}),
}),env,'/api/broadcast/operator/cards/test-card');
assert.equal(r.status,409,'shown card must be locked against live editing');
assert.equal(cards.get('test-card').headline_ru,'Test');

r=await callStatus('hidden',true);
assert.equal(r.status,200);assert.equal(cards.get('test-card').status,'hidden');
assert.equal(cards.get('test-card').shown_at,null);

console.log('BROADCAST_OPERATOR_SAFETY_OK');

function callStatus(status,authorized){
  return handleBroadcastOperatorRequest(new Request('https://example.test/api/broadcast/operator/cards/test-card/status',{
    method:'POST',headers:authorized?authHeaders():{'content-type':'application/json'},body:JSON.stringify({status}),
  }),env,'/api/broadcast/operator/cards/test-card/status');
}
function authHeaders(){return {'authorization':'Bearer operator-secret','content-type':'application/json'};}

function statement(sql){
  return {
    bind(...args){
      return {
        async first(){
          if (/FROM broadcast_cards WHERE card_id=\?/.test(sql)) return clone(cards.get(String(args[0]))||null);
          throw new Error('Unhandled first SQL: '+sql);
        },
        async run(){ return execute(sql,args); },
        async __run(){ return execute(sql,args); },
      };
    },
  };
}
function execute(sql,args){
  if (/SET status='draft'/.test(sql) && /status='preview'/.test(sql)) {
    const except=String(args[0]);
    for(const c of cards.values())if(c.status==='preview'&&c.card_id!==except)c.status='draft';
    return changes(1);
  }
  if (/SET status='preview'/.test(sql)) {
    const c=cards.get(String(args[0]));if(c){c.status='preview';c.shown_at=null;}return changes(c?1:0);
  }
  if (/SET status='hidden'/.test(sql) && /status='shown'/.test(sql)) {
    const except=String(args[0]);
    for(const c of cards.values())if(c.status==='shown'&&c.card_id!==except){c.status='hidden';c.shown_at=null;}
    return changes(1);
  }
  if (/SET status='shown'/.test(sql)) {
    const c=cards.get(String(args[0]));if(c&&c.status==='preview'){c.status='shown';c.shown_at=new Date().toISOString();return changes(1);}return changes(0);
  }
  if (/UPDATE broadcast_cards SET status=\?/.test(sql)) {
    const [status,id]=args;const c=cards.get(String(id));if(c){c.status=String(status);c.shown_at=null;}return changes(c?1:0);
  }
  throw new Error('Unhandled run SQL: '+sql);
}
function changes(n){return {meta:{changes:n},changes:n};}
function clone(v){return v?JSON.parse(JSON.stringify(v)):null;}
