import assert from "node:assert/strict";
import { runCenterNotificationTick } from "../cloudflare-worker/src/telegram-center-notification-engine.js";

const USERS=100;
const FINAL_GAME=2026101001;
const UPCOMING_GAME=2026101002;
const PLAYER=8477777;

class FakeStatement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}
  bind(...args){this.args=args;return this}
  async all(){
    if(this.sql.includes("FROM subscriptions s JOIN telegram_users u")){
      const rows=[];
      for(let i=0;i<USERS;i++){
        const uid=1000+i;
        rows.push({subscription_id:uid*10+1,telegram_user_id:uid,subject_type:"player",subject_key:String(PLAYER),notify_pregame:0,notify_start:0,notify_goal:0,notify_assist:0,notify_point:0,notify_period_end:0,notify_final:1,max_pushes_per_day:12});
        rows.push({subscription_id:uid*10+2,telegram_user_id:uid,subject_type:"game",subject_key:String(UPCOMING_GAME),notify_pregame:1,notify_start:0,notify_goal:0,notify_assist:0,notify_point:0,notify_period_end:0,notify_final:0,max_pushes_per_day:12});
      }
      return {results:rows};
    }
    if(this.sql.includes("SELECT player_id,current_team_tri,full_name_en")){
      return {results:[{player_id:PLAYER,current_team_tri:"WSH",full_name_en:"Scale Test",full_name_ru:"Тест Масштаба",active:1,position_code:"C"}]};
    }
    if(this.sql.includes("FROM telegram_users u")&&this.sql.includes("notification_user_preferences")){
      return {results:this.args.map(uid=>({telegram_user_id:Number(uid),timezone_name:"UTC",daily_player_digest:0,daily_digest_hour:20,player_postgame_reports:1}))};
    }
    if(this.sql.includes("SELECT telegram_user_id FROM notification_log"))return {results:[]};
    throw new Error("Unexpected all SQL: "+this.sql);
  }
  async first(){throw new Error("dry-run load fixture must not call first(): "+this.sql)}
  async run(){throw new Error("dry-run load fixture must not write D1: "+this.sql)}
}
class FakeDB{prepare(sql){return new FakeStatement(this,sql)}}

const finalGame={
  id:FINAL_GAME,gameDate:"2026-10-10",startTimeUTC:"2026-10-10T18:00:00Z",gameState:"FINAL",
  homeTeam:{id:15,abbrev:"WSH",score:3},awayTeam:{id:5,abbrev:"PIT",score:2},
};
const upcomingGame={
  id:UPCOMING_GAME,gameDate:"2026-10-10",startTimeUTC:"2026-10-10T20:15:00Z",gameState:"FUT",
  homeTeam:{id:10,abbrev:"TOR",score:0},awayTeam:{id:8,abbrev:"MTL",score:0},
};
const boxscore={
  playerByGameStats:{
    homeTeam:{forwards:[{playerId:PLAYER,goals:0,assists:1,points:1,sog:3,hits:1,blockedShots:0,plusMinus:1,toi:"17:10"}],defense:[],goalies:[]},
    awayTeam:{forwards:[],defense:[],goalies:[]},
  }
};

const realFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes("/schedule/2026-10-10"))return new Response(JSON.stringify({games:[finalGame,upcomingGame]}),{status:200});
  if(u.includes("/schedule/2026-10-09")||u.includes("/schedule/2026-10-11"))return new Response(JSON.stringify({games:[]}),{status:200});
  if(u.includes("/gamecenter/"+FINAL_GAME+"/boxscore"))return new Response(JSON.stringify(boxscore),{status:200});
  throw new Error("Unexpected fetch "+u);
};

try{
  const reminderUsers=new Set(),reportUsers=new Set();
  for(let minute=0;minute<5;minute++){
    const now=`2026-10-10T20:0${minute}:00Z`;
    const result=await runCenterNotificationTick({
      DB:new FakeDB(),
      TELEGRAM_CENTER_BOT_TOKEN:"fixture",
      TELEGRAM_CENTER_EVENT_STREAM_ENABLED:"0",
    },{dryRun:true,now});
    assert.equal(result.ok,true);
    const reminders=result.events.filter(x=>x.type==="reminder_15m");
    const reports=result.events.filter(x=>x.type==="player_postgame_report");
    assert.equal(reminders.length,20,`minute ${minute}: reminder shard should contain 20 of 100 users`);
    assert.equal(reports.length,20,`minute ${minute}: postgame shard should contain 20 of 100 users`);
    for(const e of reminders)reminderUsers.add(Number(e.user_id));
    for(const e of reports)reportUsers.add(Number(e.user_id));
  }
  assert.equal(reminderUsers.size,USERS,"all 100 users must be covered across five reminder ticks");
  assert.equal(reportUsers.size,USERS,"all 100 users must be covered across five postgame ticks");
  console.log("TELEGRAM_NOTIFICATION_100_USER_SHARD_OK",{users:USERS,shards:5,per_tick:20});
}finally{globalThis.fetch=realFetch}
