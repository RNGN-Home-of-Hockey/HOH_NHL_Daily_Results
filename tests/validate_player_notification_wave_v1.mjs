import assert from "node:assert/strict";
import { runCenterNotificationTick } from "../cloudflare-worker/src/telegram-center-notification-engine.js";

const USER=100, FINAL_GAME=2026020101, UPCOMING_GAME=2026020102, PLAYER_FINAL=8471001, PLAYER_UPCOMING=8471002;

class FakeStatement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}
  bind(...args){this.args=args;return this}
  async all(){
    if(this.sql.includes("FROM subscriptions s JOIN telegram_users u")){
      return {results:[
        {subscription_id:1,telegram_user_id:USER,subject_type:"player",subject_key:String(PLAYER_FINAL),notify_pregame:0,notify_start:0,notify_goal:0,notify_assist:0,notify_point:0,notify_period_end:0,notify_final:1,max_pushes_per_day:12},
        {subscription_id:2,telegram_user_id:USER,subject_type:"player",subject_key:String(PLAYER_UPCOMING),notify_pregame:0,notify_start:0,notify_goal:0,notify_assist:0,notify_point:0,notify_period_end:0,notify_final:1,max_pushes_per_day:12},
        {subscription_id:3,telegram_user_id:USER,subject_type:"game",subject_key:String(UPCOMING_GAME),notify_pregame:1,notify_start:0,notify_goal:0,notify_assist:0,notify_point:0,notify_period_end:0,notify_final:0,max_pushes_per_day:12},
      ]};
    }
    if(this.sql.includes("SELECT player_id,current_team_tri,full_name_en")){
      return {results:[
        {player_id:PLAYER_FINAL,current_team_tri:"WSH",full_name_ru:"Александр Тестов",full_name_en:"Alex Test",active:1,position_code:"L"},
        {player_id:PLAYER_UPCOMING,current_team_tri:"TOR",full_name_ru:"Иван Проверкин",full_name_en:"Ivan Check",active:0,position_code:"C"},
      ]};
    }
    if(this.sql.includes("FROM telegram_users u")&&this.sql.includes("notification_user_preferences")){
      return {results:[{telegram_user_id:USER,timezone_name:"UTC",daily_player_digest:1,daily_digest_hour:20,player_postgame_reports:1}]};
    }
    throw new Error("Unexpected all SQL: "+this.sql);
  }
  async first(){throw new Error("dry-run fixture must not call first(): "+this.sql)}
  async run(){throw new Error("dry-run fixture must not write D1: "+this.sql)}
}
class FakeDB{prepare(sql){return new FakeStatement(this,sql)}}

const finalGame={
  id:FINAL_GAME,gameDate:"2026-10-10",startTimeUTC:"2026-10-10T18:00:00Z",gameState:"FINAL",
  homeTeam:{id:15,abbrev:"WSH",score:4},awayTeam:{id:5,abbrev:"PIT",score:2},
};
const upcomingGame={
  id:UPCOMING_GAME,gameDate:"2026-10-10",startTimeUTC:"2026-10-10T20:15:00Z",gameState:"FUT",
  homeTeam:{id:10,abbrev:"TOR",score:0},awayTeam:{id:8,abbrev:"MTL",score:0},
};
const boxscore={
  playerByGameStats:{
    homeTeam:{forwards:[{playerId:PLAYER_FINAL,goals:1,assists:2,points:3,sog:5,hits:2,blockedShots:1,plusMinus:2,toi:"18:41"}],defense:[],goalies:[]},
    awayTeam:{forwards:[],defense:[],goalies:[]},
  }
};

const realFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes("/schedule/2026-10-10"))return new Response(JSON.stringify({games:[finalGame,upcomingGame]}),{status:200});
  if(u.includes("/schedule/2026-10-09")||u.includes("/schedule/2026-10-11"))return new Response(JSON.stringify({games:[]}),{status:200});
  if(u.includes("/gamecenter/"+FINAL_GAME+"/boxscore"))return new Response(JSON.stringify(boxscore),{status:200});
  if(u.includes("site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries"))return new Response(JSON.stringify({
    injuries:[{team:{abbreviation:"TOR"},athlete:{displayName:"Ivan Check"},status:"Out",details:{detail:"Lower Body"}}]
  }),{status:200});
  throw new Error("Unexpected fetch "+u);
};

try{
  const result=await runCenterNotificationTick({
    DB:new FakeDB(),
    TELEGRAM_CENTER_BOT_TOKEN:"fixture",
    TELEGRAM_CENTER_EVENT_STREAM_ENABLED:"0",
  },{dryRun:true,now:"2026-10-10T20:00:00Z"});

  assert.equal(result.ok,true);
  assert.equal(result.daily_digests,1,"one local 20:00 digest expected");
  assert.equal(result.game_reminders,1,"one explicit 15-minute game reminder expected");
  assert.equal(result.player_reports,1,"one postgame followed-player report expected");
  assert.ok(result.injury_feed_records>=1,"injury feed should be loaded for the local digest");

  const digest=result.events.find(x=>x.type==="daily_player_digest");
  assert.ok(digest);
  assert.match(digest.text,/Иван Проверкин/);
  assert.match(digest.text,/TOR vs MTL/);
  assert.match(digest.text,/травмирован, не сыграет/);
  assert.match(digest.text,/Lower Body/);
  assert.doesNotMatch(digest.text,/вне активного состава/);
  assert.doesNotMatch(digest.text,/Александр Тестов/,"completed game must not be repeated in evening digest");

  const reminder=result.events.find(x=>x.type==="reminder_15m");
  assert.ok(reminder);
  assert.match(reminder.text,/около 15 минут/);
  assert.equal(reminder.subscriptions.length,1);
  assert.equal(reminder.subscriptions[0].subject_type,"game");

  const report=result.events.find(x=>x.type==="player_postgame_report");
  assert.ok(report);
  assert.match(report.text,/Александр Тестов/);
  assert.match(report.text,/1\+2=3/);
  assert.match(report.text,/5 брос/);
  assert.match(report.text,/TOI 18:41/);

  assert.ok(!result.events.some(x=>["goal","start","period_end","final","pregame"].includes(x.type)),"first-wave mode must not enable the legacy event firehose");
  console.log("TELEGRAM_PLAYER_REMINDERS_V1_OK", {daily:result.daily_digests,reminders:result.game_reminders,reports:result.player_reports});
}finally{globalThis.fetch=realFetch}
