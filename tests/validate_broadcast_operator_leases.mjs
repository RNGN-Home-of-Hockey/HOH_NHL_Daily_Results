import { strict as assert } from 'node:assert';
import { handleBroadcastOperatorRequest } from '../cloudflare-worker/src/broadcast-operator.js';

const leases=new Map();
const env={BROADCAST_OPERATOR_OPEN:'1',DB:{prepare(sql){return statement(sql)}}};
const gamePk=2026020999;

let r=await lease('POST','operator-alpha','Альфа');
assert.equal(r.status,200);
let d=await r.json();
assert.equal(d.lease.operator_id,'operator-alpha');

r=await lease('POST','operator-beta','Бета');
assert.equal(r.status,423,'second operator must not take an active room');
d=await r.json();
assert.equal(d.error,'game_locked');
assert.equal(d.lease.operator_name,'Альфа');

r=await handleBroadcastOperatorRequest(
  new Request('https://example.test/api/broadcast/operator/leases/'+gamePk),
  env,
  '/api/broadcast/operator/leases/'+gamePk
);
d=await r.json();
assert.equal(d.lease.operator_id,'operator-alpha');

// Simulate lease expiry: the next operator may take over without manual cleanup.
leases.get(gamePk).expires_at='2000-01-01T00:00:00.000Z';
r=await lease('POST','operator-beta','Бета');
assert.equal(r.status,200,'expired room must be acquirable by another operator');
d=await r.json();
assert.equal(d.lease.operator_id,'operator-beta');

r=await lease('DELETE','operator-beta','Бета');
assert.equal(r.status,200);
d=await r.json();
assert.equal(d.lease,null);

console.log('BROADCAST_OPERATOR_LEASE_COLLISION_OK');

function lease(method,operator_id,operator_name){
  return handleBroadcastOperatorRequest(new Request('https://example.test/api/broadcast/operator/leases/'+gamePk,{
    method,
    headers:{'content-type':'application/json'},
    body:JSON.stringify({operator_id,operator_name}),
  }),env,'/api/broadcast/operator/leases/'+gamePk);
}
function statement(sql){
  return {
    bind(...args){
      return {
        async first(){
          if(/FROM broadcast_operator_leases/.test(sql)){
            const row=leases.get(Number(args[0]));
            if(!row)return null;
            return Date.parse(row.expires_at)>Date.now()?{...row}:null;
          }
          throw new Error('Unhandled first SQL: '+sql);
        },
        async run(){
          if(/INSERT INTO broadcast_operator_leases/.test(sql)){
            const [pk,id,name]=args;
            const key=Number(pk),current=leases.get(key),active=current&&Date.parse(current.expires_at)>Date.now();
            if(!active||current.operator_id===id){
              const now=new Date();
              leases.set(key,{
                game_pk:key,
                operator_id:String(id),
                operator_name:String(name),
                acquired_at:current?.operator_id===id?current.acquired_at:now.toISOString(),
                expires_at:new Date(now.getTime()+90000).toISOString(),
                updated_at:now.toISOString(),
              });
              return changes(1);
            }
            return changes(0);
          }
          if(/DELETE FROM broadcast_operator_leases/.test(sql)){
            const [pk,id]=args;const key=Number(pk),current=leases.get(key);
            if(current&&current.operator_id===String(id)){leases.delete(key);return changes(1)}
            return changes(0);
          }
          if(/UPDATE broadcast_operator_leases/.test(sql)){
            const [pk,id]=args;const current=leases.get(Number(pk));
            if(current&&current.operator_id===String(id)){current.expires_at=new Date(Date.now()+90000).toISOString();return changes(1)}
            return changes(0);
          }
          throw new Error('Unhandled run SQL: '+sql);
        }
      };
    }
  };
}
function changes(n){return {meta:{changes:n},changes:n};}
