import { strict as assert } from "node:assert";
import { buildH2HBroadcastInsights } from "../cloudflare-worker/src/h2h-broadcast-insights.js";

const game={game_pk:77,scheduled_start_utc:"2026-10-01T00:00:00Z",away_tri:"FLA",home_tri:"CAR"};
const rows=Array.from({length:6},(_,i)=>({
  game_pk:100+i,
  final_goals_for:i<4?4:2,final_goals_against:i<4?2:3,total_goals:i<5?6:4,final_goal_diff:i<4?2:-1,final_win:i<4?1:0,
  regulation_result:i<4?"W":"L",regulation_goal_diff:i<4?1:-1,
  p1_goals_for:i<4?1:0,p1_goals_against:i<4?0:1,p2_goals_for:2,p2_goals_against:1,p3_goals_for:1,p3_goals_against:1
}));
const db={prepare(){return{bind(){return{all:async()=>({results:rows})}}}}};
const now="2026-09-23T10:45:00Z";
const real={provider:"winline",status:"open",updated_at:now,event_id:"e",is_live:false};
const markets=[
  {...real,market_type:"moneyline",period:"GAME",subject:"FLA",side:"FLA",line:null,odds:2.10},
  {...real,market_type:"game_total",period:"GAME",subject:null,side:"over",line:5.5,odds:1.85},
  {...real,market_type:"handicap",period:"GAME",subject:"CAR",side:"CAR",line:1.5,odds:1.60},
  {...real,market_type:"game_total",period:"GAME",subject:null,side:"under",line:7.5,odds:1.25,is_live:true}
];
const cards=await buildH2HBroadcastInsights(db,game,markets);
assert.ok(cards.length>=3);
assert.ok(cards.every(c=>c.category==="h2h_broadcast"&&c.evidence.split==="h2h"));
assert.ok(cards.every(c=>c.market.odds_is_demo===false&&c.market.odds_source==="provider_live"));
const ml=cards.find(c=>c.market.type==="moneyline"&&c.market.subject==="FLA");
assert.ok(ml);
assert.equal(ml.evidence.hits,4);
assert.equal(ml.evidence.decisions,6);
assert.match(ml.title,/4 ИЗ 6 В ОЧНЫХ МАТЧАХ/);
const total=cards.find(c=>c.market.type==="game_total"&&c.market.line===5.5);
assert.ok(total);
assert.equal(total.evidence.hits,5);
assert.equal(cards.some(c=>c.market.line===7.5),false,"live line must not leak into pregame H2H cards");
console.log("H2H_CURRENT_LINE_BROADCAST_OK");
