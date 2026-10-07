import { strict as assert } from "node:assert";
import fs from "node:fs";
import { buildLiveCards, attachLiveWinlineMarkets } from "../cloudflare-worker/src/live-betting-engine.js";
import { buildProviderHistoryCards, mergeLiveInsightCards, repricePregameLiveCards } from "../cloudflare-worker/src/live-context-engine.js";

const game={game_pk:2026020001,home_tri:"CAR",away_tri:"FLA",home_score:1,away_score:1,period_number:2,game_state:"LIVE",seconds_remaining:600,time_remaining:"10:00"};
const shots=[];for(let i=0;i<10;i++)shots.push({sort_order:i+1,event_type:"shot-on-goal",team_tri:i<8?"CAR":"FLA",period_number:2,period_type:"REG",elapsed_seconds:1200+i*30});
const raw=buildLiveCards(game,shots);
assert.ok(raw.some(c=>c.market?.type==="next_goal_team"&&c.market?.subject==="CAR"),"elite shot pressure may create one next-goal card");
assert.equal(raw.some(c=>c.market?.type==="moneyline"),false,"shots must never create a match-winner card");
assert.equal(raw.some(c=>c.market?.type==="game_total"),false,"shots must never create a total card");
assert.ok(raw.every(c=>Number(c.score)<=70&&c.live_origin==="shot_support"),"shot cards must be secondary");

const now=new Date().toISOString();
const shotProvider=[
  {provider:"winline",market_type:"next_goal_team",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.91,status:"open",is_live:true,updated_at:now,market_id:"shot-next"},
  {provider:"winline",market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.84,status:"open",is_live:true,updated_at:now,market_id:"shot-ml"},
];
const enriched=attachLiveWinlineMarkets({ok:true,game,cards:raw,live_context:{recent_5m:{total:10,share:.8,leader:"CAR",leader_shots:8,opponent:"FLA",opponent_shots:2,minutes:5},recent_10m:{total:10,share:.8,leader:"CAR",leader_shots:8,opponent:"FLA",opponent_shots:2,minutes:10}}},shotProvider,{now,market_max_age_ms:300000});
assert.ok(enriched.cards.some(c=>c.market.type==="next_goal_team"&&c.market.odds===1.91));
assert.equal(enriched.cards.some(c=>c.market.type==="moneyline"),false,"provider fallback must not turn shots into moneyline");

const mkRows=(team,strong=true)=>Array.from({length:10},(_,i)=>({
  game_pk:1000+i,is_home:i%2,final_win:strong?(i<7?1:0):(i<4?1:0),final_goals_for:strong?(i<7?4:2):(i<4?4:2),final_goals_against:strong?(i<7?2:4):(i<4?2:4),
  final_goal_diff:strong?(i<7?2:-2):(i<4?2:-2),total_goals:i<7?7:4,
  p1_goals_for:i<6?2:0,p1_goals_against:i<6?0:1,
  p2_goals_for:strong?(i<7?2:0):(i<6?0:1),p2_goals_against:strong?(i<7?0:1):(i<6?2:0),
  p3_goals_for:i<6?1:0,p3_goals_against:i<6?0:1,
}));
const rows=new Map([["CAR",mkRows("CAR",true)],["FLA",mkRows("FLA",false)]]);
const snapshot={ok:true,game,live_context:{periods:[{period:1,goals_by_team:{CAR:0,FLA:0},goals_total:0},{period:2,goals_by_team:{CAR:1,FLA:0},goals_total:1},{period:3,goals_by_team:{CAR:0,FLA:0},goals_total:0}],current_period:{period:2,goals_by_team:{CAR:1,FLA:0},goals_total:1}}};
const provider=[
  {provider:"winline",market_type:"period_2_result",period:"P2",subject:"CAR",side:"CAR",line:null,odds:2.05,status:"open",is_live:true,updated_at:now,market_id:"p2-car",selection_id:"p2-car"},
  {provider:"winline",market_type:"game_total",period:"P2",subject:null,side:"over",line:1.5,odds:1.88,status:"open",is_live:true,updated_at:now,market_id:"p2-over",selection_id:"p2-over"},
  {provider:"winline",market_type:"team_total",period:"GAME",subject:"CAR",side:"over",line:2.5,odds:1.95,status:"open",is_live:true,updated_at:now,market_id:"car-tt",selection_id:"car-tt"},
  {provider:"winline",market_type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.90,status:"open",is_live:true,updated_at:now,market_id:"car-ml",selection_id:"car-ml"},
];
const history=buildProviderHistoryCards(snapshot,provider,rows,{now,market_max_age_ms:300000});
assert.ok(history.some(c=>c.live_origin==="period_result_history"),"period result history must participate in live");
assert.ok(history.some(c=>c.live_origin==="period_total_history"),"period total history must participate in live");
assert.ok(history.some(c=>c.live_origin==="team_total_history"),"team/opponent scoring history must participate in live");
assert.ok(history.some(c=>c.live_origin==="moneyline_history"),"pregame form + current score may support moneyline");
assert.ok(history.every(c=>!/ПО БРОСКАМ/.test(c.broadcast_title||"")),"primary historical live cards must not be shot-led");

const pregame=[{id:"pre-ml",air_score:82,broadcast_title:"CAR выиграл 7 из последних 10 матчей",evidence:{sample:10,hits:7},market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null}}];
const repriced=repricePregameLiveCards(snapshot,pregame,provider,{now,market_max_age_ms:300000});
assert.equal(repriced.length,1);assert.equal(repriced[0].live_origin,"pregame_repriced");assert.equal(repriced[0].market.odds,1.90);

const mixed=mergeLiveInsightCards([...history,...repriced],enriched.cards);
assert.ok(mixed.length>=4,"live queue should have several non-shot angles");
assert.ok(mixed.filter(c=>c.live_origin==="shot_support").length<=1,"live mix caps shots at one card");
assert.ok(mixed.filter(c=>c.live_origin!=="shot_support").length>=3,"non-shot context must dominate live queue");

const dash=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-dashboard-v2.js',import.meta.url),'utf8');
for(const needle of ["origin==='shot_support'&&used>=1","СТАТИСТИКА ПО ПЕРИОДАМ","ПРЕДМАТЧЕВЫЙ СИГНАЛ","LIVE · ПЕРИОДЫ И ФОРМА"])assert.ok(dash.includes(needle),'dashboard diversity marker missing '+needle);
console.log("LIVE_MARKET_ENRICHMENT_V3_OK");
