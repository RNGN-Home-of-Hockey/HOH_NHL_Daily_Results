import { strict as assert } from "node:assert";
import { buildH2HBroadcastInsights } from "../cloudflare-worker/src/h2h-broadcast-insights.js";

const game={game_pk:77,scheduled_start_utc:"2026-10-01T00:00:00Z",away_tri:"FLA",home_tri:"CAR",away_name_ru:"Флорида Пантерз",home_name_ru:"Каролина Харрикейнз"};
const rows=Array.from({length:6},(_,i)=>{
  const win=i<4;
  const finalFor=win?4:2,finalAgainst=win?2:(i===4?4:3);
  const p1gf=win?1:0,p1ga=win?0:1;
  const p2gf=win?2:1,p2ga=win?1:(i===4?2:1);
  const p3gf=finalFor-p1gf-p2gf,p3ga=finalAgainst-p1ga-p2ga;
  const regGf=p1gf+p2gf+p3gf,regGa=p1ga+p2ga+p3ga;
  return {
    game_pk:100+i,team_tri:"FLA",opponent_tri:"CAR",is_home:0,
    official_home_tri:"CAR",official_away_tri:"FLA",official_home_score:finalAgainst,official_away_score:finalFor,
    official_current_period:3,official_period_type:"REG",official_game_state:"FINAL",went_ot:0,went_so:0,
    final_goals_for:finalFor,final_goals_against:finalAgainst,total_goals:finalFor+finalAgainst,final_goal_diff:finalFor-finalAgainst,final_win:finalFor>finalAgainst?1:0,
    regulation_goals_for:regGf,regulation_goals_against:regGa,regulation_result:regGf>regGa?"W":regGf<regGa?"L":"T",regulation_goal_diff:regGf-regGa,
    p1_goals_for:p1gf,p1_goals_against:p1ga,p2_goals_for:p2gf,p2_goals_against:p2ga,p3_goals_for:p3gf,p3_goals_against:p3ga,
    raw_p1_goals_for:p1gf,raw_p1_goals_against:p1ga,raw_p2_goals_for:p2gf,raw_p2_goals_against:p2ga,raw_p3_goals_for:p3gf,raw_p3_goals_against:p3ga,
    event_p1_goals_for:p1gf,event_p1_goals_against:p1ga,event_p2_goals_for:p2gf,event_p2_goals_against:p2ga,event_p3_goals_for:p3gf,event_p3_goals_against:p3ga
  };
});
const db={prepare(){return{bind(){return{all:async()=>({results:rows})}}}}};
const now="2026-09-23T10:45:00Z";
const real={provider:"winline",status:"open",updated_at:now,event_id:"e",is_live:false};
const markets=[
  {...real,market_type:"moneyline",period:"GAME",subject:"FLA",side:"FLA",line:null,odds:2.10},
  {...real,market_type:"game_total",period:"GAME",subject:null,side:"over",line:5.5,odds:1.85},
  {...real,market_type:"handicap",period:"GAME",subject:"CAR",side:"CAR",line:1.5,odds:1.60},
  {...real,market_type:"period_2_result",period:"P2",subject:"FLA",side:"FLA",line:null,odds:2.55},
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
assert.match(ml.title,/ФЛОРИДА ПАНТЕРЗ ОБЫГРЫВАЛИ КАРОЛИНА ХАРРИКЕЙНЗ В 4 ИЗ 6 ПОСЛЕДНИХ МАТЧЕЙ/);
assert.equal(ml.evidence.team,"FLA");
assert.equal(ml.evidence.opponent,"CAR");
const p2=cards.find(c=>c.market.type==="period_2_result"&&c.market.subject==="FLA");
assert.ok(p2,"verified period line should survive H2H evaluation");
assert.equal(p2.evidence.period_data_verified,true);
assert.equal(p2.evidence.stats_validation,"exact_market_v6_official_score_crosscheck");
assert.equal(p2.evidence.official_score_verified,true);
const total=cards.find(c=>c.market.type==="game_total"&&c.market.line===5.5);
assert.ok(total);
assert.equal(total.evidence.hits,5);
assert.equal(cards.some(c=>c.market.line===7.5),false,"live line must not leak into pregame H2H cards");
console.log("H2H_CURRENT_LINE_BROADCAST_OK");
