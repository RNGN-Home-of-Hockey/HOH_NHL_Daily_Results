import assert from "node:assert/strict";
import { processCenterReminderCallback } from "../cloudflare-worker/src/telegram-product-bot.js";

const USER=777, G1=2026020101, G2=2026020102;

class FakeStatement {
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}
  bind(...args){this.args=args;return this}
  async all(){
    if(this.sql.includes("SELECT subject_key")&&this.sql.includes("subject_type='game'")){
      const ids=this.args.slice(1).map(Number);
      return {results:ids.filter(id=>this.db.reminders.has(id)).map(id=>({subject_key:String(id)}))};
    }
    throw new Error("Unexpected all SQL: "+this.sql);
  }
  async run(){
    if(this.sql.includes("INSERT INTO telegram_users"))return {meta:{changes:1}};
    if(this.sql.includes("INSERT INTO subscriptions")){
      this.db.reminders.add(Number(this.args[1]));
      return {meta:{changes:1}};
    }
    if(this.sql.includes("UPDATE subscription_preferences"))return {meta:{changes:0}};
    if(this.sql.includes("UPDATE subscriptions SET notify_pregame=0")){
      this.db.reminders.delete(Number(this.args[1]));
      return {meta:{changes:1}};
    }
    if(this.sql.includes("DELETE FROM subscriptions"))return {meta:{changes:0}};
    throw new Error("Unexpected run SQL: "+this.sql);
  }
}
class FakeDB {
  constructor(){this.reminders=new Set()}
  prepare(sql){return new FakeStatement(this,sql)}
}

const baseKeyboard={inline_keyboard:[
  [{text:"☐ MIN — NSH · 03:00",callback_data:`center_gr:${G1}:1`}],
  [{text:"☐ EDM — VAN · 05:00",callback_data:`center_gr:${G2}:1`}],
  [{text:"🔔 Все матчи",callback_data:"center_gra:1"}],
]};

const db=new FakeDB();
const telegramCalls=[];
const realFetch=globalThis.fetch;
globalThis.fetch=async (url,opts={})=>{
  const method=String(url).split("/").at(-1);
  const payload=JSON.parse(String(opts.body||"{}"));
  telegramCalls.push({method,payload});
  return new Response(JSON.stringify({ok:true,result:true}),{status:200,headers:{"content-type":"application/json"}});
};

function callback(data,reply_markup,id="cb1"){
  return {
    id,
    data,
    from:{id:USER,username:"tester",first_name:"Test",language_code:"ru"},
    message:{message_id:55,chat:{id:USER,type:"private"},reply_markup},
  };
}

try{
  const env={DB:db,TELEGRAM_CENTER_BOT_TOKEN:"fixture-token"};

  const one=await processCenterReminderCallback(env,callback(`center_gr:${G1}:1`,baseKeyboard));
  assert.equal(one.handled,true);
  assert.equal(one.ok,true);
  assert.equal(one.enabled,true);
  assert.deepEqual([...db.reminders],[G1]);
  const edit1=telegramCalls.find(x=>x.method==="editMessageReplyMarkup");
  assert.ok(edit1,"individual callback must edit keyboard");
  const flat1=edit1.payload.reply_markup.inline_keyboard.flat();
  assert.match(flat1.find(x=>x.callback_data===`center_gr:${G1}:0`).text,/^✅/);
  assert.match(flat1.find(x=>x.callback_data===`center_gr:${G2}:1`).text,/^☐/);
  assert.equal(flat1.find(x=>x.callback_data==="center_gra:1").text,"◩ Все матчи");

  telegramCalls.length=0;
  const all=await processCenterReminderCallback(env,callback("center_gra:1",edit1.payload.reply_markup,"cb2"));
  assert.equal(all.ok,true);
  assert.equal(all.enabled,true);
  assert.deepEqual([...db.reminders].sort((a,b)=>a-b),[G1,G2]);
  const edit2=telegramCalls.find(x=>x.method==="editMessageReplyMarkup");
  const flat2=edit2.payload.reply_markup.inline_keyboard.flat();
  assert.ok(flat2.filter(x=>/^center_gr:\\d+:[01]$/.test(x.callback_data||"")).every(x=>String(x.text).startsWith("✅")));
  assert.equal(flat2.find(x=>x.callback_data==="center_gra:0").text,"✅ Все матчи");
  assert.ok(telegramCalls.some(x=>x.method==="answerCallbackQuery"),"callback must be acknowledged");

  telegramCalls.length=0;
  const off=await processCenterReminderCallback(env,callback("center_gra:0",edit2.payload.reply_markup,"cb3"));
  assert.equal(off.ok,true);
  assert.equal(off.enabled,false);
  assert.equal(db.reminders.size,0);

  // Replaying the same explicit target is safe: it must not toggle back on.
  telegramCalls.length=0;
  const replay=await processCenterReminderCallback(env,callback("center_gra:0",edit2.payload.reply_markup,"cb4"));
  assert.equal(replay.handled,true);
  assert.equal(replay.enabled,false);
  assert.equal(db.reminders.size,0);

  console.log("CENTER_DIGEST_CALLBACKS_OK",{individual:one.games,all:all.games,disabled:off.games});
}finally{
  globalThis.fetch=realFetch;
}
