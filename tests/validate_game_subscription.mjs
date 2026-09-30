import assert from 'node:assert/strict';
import { handleTelegramGameSubscriptionRequest } from '../cloudflare-worker/src/telegram-game-subscriptions.js';

const token='fixture-bot-token';
const user={id:123456,first_name:'Fixture',username:'fixture'};
const gamePk=2026020001;

async function hmac(keyBytes,message){
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message)));
}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function initData(){
  const authDate=Math.floor(Date.now()/1000);
  const params=new URLSearchParams();
  params.set('auth_date',String(authDate));
  params.set('query_id','fixture-query');
  params.set('user',JSON.stringify(user));
  const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=await hmac(new TextEncoder().encode('WebAppData'),token);
  const signature=await hmac(secret,check);
  params.set('hash',hex(signature));
  return params.toString();
}

class FakeStatement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}
  bind(...args){this.args=args;return this}
  async run(){
    if(this.sql.includes('INSERT INTO telegram_users')){this.db.users.add(Number(this.args[0]));return {meta:{changes:1}}}
    if(this.sql.includes('INSERT INTO subscriptions')){
      const key=`${this.args[0]}:game:${this.args[1]}`,current=this.db.follows.get(key);
      if(this.sql.includes("VALUES(?,'game',?,1,0,0,0,0,0,0)")){
        this.db.follows.set(key,{...(current||{}),subscription_id:1,subject_type:'game',subject_key:String(this.args[1]),notify_pregame:1,notify_start:current?.notify_start||0,notify_goal:current?.notify_goal||0,notify_assist:current?.notify_assist||0,notify_point:current?.notify_point||0,notify_period_end:current?.notify_period_end||0,notify_final:current?.notify_final||0,created_at:'NOW'});
      }else{
        this.db.follows.set(key,{subscription_id:1,subject_type:'game',subject_key:String(this.args[1]),notify_pregame:this.args[2],notify_start:this.args[3],notify_goal:this.args[4],notify_assist:this.args[5],notify_point:0,notify_period_end:this.args[6],notify_final:this.args[7],created_at:'NOW'});
      }
      return {meta:{changes:1}};
    }
    if(this.sql.includes('UPDATE subscriptions SET notify_pregame=0')){
      const key=`${this.args[0]}:game:${this.args[1]}`,row=this.db.follows.get(key);if(row)row.notify_pregame=0;return {meta:{changes:row?1:0}};
    }
    if(this.sql.includes('DELETE FROM subscriptions')){
      const key=`${this.args[0]}:game:${this.args[1]}`,row=this.db.follows.get(key);
      if(this.sql.includes('COALESCE(notify_pregame,0)=0')){
        const empty=row&&['notify_pregame','notify_start','notify_goal','notify_assist','notify_point','notify_period_end','notify_final'].every(k=>Number(row[k]||0)===0);
        if(empty)this.db.follows.delete(key);
      }else this.db.follows.delete(key);
      return {meta:{changes:1}};
    }
    throw new Error('Unexpected run SQL '+this.sql);
  }
  async all(){
    if(this.sql.includes('FROM subscriptions WHERE telegram_user_id=')){
      const uid=Number(this.args[0]);
      return {results:[...this.db.follows.entries()].filter(([key])=>key.startsWith(uid+':')).map(([,value])=>value)};
    }
    throw new Error('Unexpected all SQL '+this.sql);
  }
}
class FakeDB{constructor(){this.users=new Set();this.follows=new Map()}prepare(sql){return new FakeStatement(this,sql)}}

const db=new FakeDB();
const realFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  if(String(url).includes(`/gamecenter/${gamePk}/boxscore`))return new Response(JSON.stringify({id:gamePk}),{status:200});
  throw new Error('Unexpected fetch '+url);
};

try{
  const auth=await initData();
  let request=new Request('https://example.test/api/telegram-app/follows',{
    method:'POST',headers:{'content-type':'application/json','x-telegram-init-data':auth},
    body:JSON.stringify({subject_type:'game',subject_key:String(gamePk),notify_goal:true,notify_period_end:true}),
  });
  let response=await handleTelegramGameSubscriptionRequest(request,{DB:db,TELEGRAM_BOT_TOKEN:token},'/api/telegram-app/follows');
  assert.equal(response.status,200);
  let payload=await response.json();
  assert.equal(payload.ok,true);assert.equal(payload.removed,false);assert.equal(payload.follows.length,1);
  assert.equal(payload.follows[0].subject_key,String(gamePk));assert.equal(payload.follows[0].notify_goal,1);assert.equal(payload.follows[0].notify_period_end,1);

  request=new Request('https://example.test/api/telegram-app/follows',{
    method:'DELETE',headers:{'content-type':'application/json','x-telegram-init-data':auth},
    body:JSON.stringify({subject_type:'game',subject_key:String(gamePk)}),
  });
  response=await handleTelegramGameSubscriptionRequest(request,{DB:db,TELEGRAM_BOT_TOKEN:token},'/api/telegram-app/follows');
  assert.equal(response.status,200);payload=await response.json();assert.equal(payload.removed,true);assert.equal(payload.follows.length,0);

  request=new Request('https://example.test/api/telegram-app/follows',{
    method:'POST',headers:{'content-type':'application/json','x-telegram-init-data':auth},
    body:JSON.stringify({subject_type:'game',subject_key:String(gamePk),reminder_only:true}),
  });
  response=await handleTelegramGameSubscriptionRequest(request,{DB:db,TELEGRAM_BOT_TOKEN:token},'/api/telegram-app/follows');
  assert.equal(response.status,200);payload=await response.json();
  assert.equal(payload.follows.length,1);assert.equal(payload.follows[0].notify_pregame,1);assert.equal(payload.follows[0].notify_start,0);assert.equal(payload.follows[0].notify_final,0);

  request=new Request('https://example.test/api/telegram-app/follows',{
    method:'DELETE',headers:{'content-type':'application/json','x-telegram-init-data':auth},
    body:JSON.stringify({subject_type:'game',subject_key:String(gamePk),reminder_only:true}),
  });
  response=await handleTelegramGameSubscriptionRequest(request,{DB:db,TELEGRAM_BOT_TOKEN:token},'/api/telegram-app/follows');
  assert.equal(response.status,200);payload=await response.json();assert.equal(payload.follows.length,0,'reminder-only row should disappear after reminder is disabled');

  const bad=new Request('https://example.test/api/telegram-app/follows',{
    method:'POST',headers:{'content-type':'application/json','x-telegram-init-data':'auth_date=1&user=%7B%22id%22%3A1%7D&hash=bad'},
    body:JSON.stringify({subject_type:'game',subject_key:String(gamePk)}),
  });
  response=await handleTelegramGameSubscriptionRequest(bad,{DB:db,TELEGRAM_BOT_TOKEN:token},'/api/telegram-app/follows');
  assert.equal(response.status,401);
  console.log('TELEGRAM_GAME_SUBSCRIPTION_OK');
}finally{globalThis.fetch=realFetch}
