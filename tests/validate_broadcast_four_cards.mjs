import { strict as assert } from "node:assert";
import { MIN_BROADCAST_ODDS, selectBroadcastFour } from "../cloudflare-worker/src/broadcast-four-card-selector.js";
import { buildCommentatorBrief } from "../cloudflare-worker/src/commentator-brief.js";

const game={game_pk:1,away_tri:"FLA",home_tri:"CAR",away_name_ru:"Флорида",home_name_ru:"Каролина"};
const real={odds_is_demo:false,odds_source:"provider_live"};
const cards=[
  {id:"car",category:"advanced_market",air_score:95,broadcast_title:"КАРОЛИНА — ТОП-2 НХЛ ПО СОЗДАННЫМ ОПАСНЫМ МОМЕНТАМ",evidence:{team:"CAR",team_rank:2,opponent:"FLA",opponent_rank:18,sample:82},market:{type:"moneyline",subject:"CAR",side:"CAR",label:"Победа CAR",odds:1.79,...real}},
  {id:"fla",category:"provider_history",air_score:92,broadcast_title:"ФЛОРИДА ВЫИГРАЛА 7 ИЗ 10",evidence:{team:"FLA",hits:7,decisions:10,hit_rate:.7},market:{type:"moneyline",subject:"FLA",side:"FLA",label:"Победа FLA",odds:2.01,...real}},
  {id:"generic",category:"market_combination",air_score:100,broadcast_title:"ПОБЕДУ ФЛОРИДЫ ПОДТВЕРЖДАЮТ 3 НЕЗАВИСИМЫХ СИГНАЛА",evidence:{team:"FLA"},market:{type:"moneyline",subject:"FLA",side:"FLA",label:"Победа FLA",odds:2.01,...real}},
  {id:"h2h-total",category:"h2h_market",air_score:86,broadcast_title:"ТБ 5,5 ПРОШЁЛ В 5 ИЗ 6 ОЧНЫХ МАТЧЕЙ",evidence:{split:"h2h",hits:5,sample:6,hit_rate:.833,window:6,independent_support_count:2,supporting_signals:[{title:"ФЛОРИДА ЗАБИВАЛА 3+ В 5 ИЗ 6"},{title:"КАРОЛИНА ПРОПУСКАЛА 3+ В 4 ИЗ 6"}]},market:{type:"game_total",subject:null,side:"over",line:5.5,label:"ТБ 5.5",odds:1.91,...real}},
  {id:"h2h-win",category:"h2h_market",air_score:84,broadcast_title:"КАРОЛИНА ВЫИГРАЛА 4 ИЗ 6 ОЧНЫХ МАТЧЕЙ",evidence:{split:"h2h",team:"CAR",hits:4,sample:6,hit_rate:.667,window:6},market:{type:"moneyline",subject:"CAR",side:"CAR",label:"Победа CAR",odds:1.79,...real}},
  {id:"h2h-total2",category:"h2h_market",air_score:82,broadcast_title:"ТБ 6,5 ПРОШЁЛ В 4 ИЗ 6 ОЧНЫХ МАТЧЕЙ",evidence:{split:"h2h",hits:4,sample:6,hit_rate:.667,window:6},market:{type:"game_total",subject:null,side:"over",line:6.5,label:"ТБ 6.5",odds:2.22,...real}}
];
const four=selectBroadcastFour(cards,game);
assert.equal(four.length,4);
assert.equal(four.filter(c=>c.broadcast_group==="team_form").length,2);
assert.equal(four.filter(c=>c.broadcast_group==="h2h").length,2);
assert.ok(four.some(c=>c.id==="car"));
assert.ok(four.some(c=>c.id==="fla"));
assert.ok(!four.some(c=>c.id==="generic"),"generic signal-count card must not take a main slot");
assert.ok(four.filter(c=>c.broadcast_group==="h2h").some(c=>c.market.type==="game_total"));
assert.ok(four.filter(c=>c.broadcast_group==="h2h").some(c=>c.market.type==="moneyline"));

assert.equal(MIN_BROADCAST_ODDS,1.5);
const noH2H=[
  {id:"g1",category:"provider_history",air_score:96,broadcast_title:"CAR 8 ИЗ 10",evidence:{team:"CAR",hits:8,sample:10,hit_rate:.8},market:{type:"handicap",subject:"CAR",side:"over",line:-1.5,odds:2.20,...real}},
  {id:"g2",category:"advanced_market",air_score:94,broadcast_title:"FLA 7 ИЗ 10",evidence:{team:"FLA",hits:7,sample:10,hit_rate:.7},market:{type:"team_total",subject:"FLA",side:"over",line:2.5,odds:1.88,...real}},
  {id:"g3",category:"market_history",air_score:91,broadcast_title:"CAR P1 6 ИЗ 10",evidence:{team:"CAR",hits:6,sample:10,hit_rate:.6},market:{type:"period_1_result",period:"P1",subject:"CAR",side:"CAR",odds:2.65,...real}},
  {id:"g4",category:"advanced_market",air_score:89,broadcast_title:"ТБ 6.5 7 ИЗ 10",evidence:{team:"FLA",hits:7,sample:10,hit_rate:.7},market:{type:"game_total",subject:null,side:"over",line:6.5,odds:1.74,...real}},
  {id:"cheap",category:"provider_history",air_score:100,broadcast_title:"ДЕШЁВАЯ ЛИНИЯ",evidence:{team:"CAR",hits:10,sample:10,hit_rate:1},market:{type:"moneyline",subject:"CAR",side:"CAR",odds:1.20,...real}},
];
const noH2HFour=selectBroadcastFour(noH2H,game);
assert.equal(noH2HFour.length,4,"missing H2H must be backfilled to four commentator choices");
assert.equal(noH2HFour.filter(c=>c.broadcast_group==="team_form").length,4);
assert.ok(!noH2HFour.some(c=>c.id==="cheap"),"odds below 1.50 must never enter featured broadcast choices");
assert.ok(noH2HFour.every(c=>Number(c.market.odds)>=1.5));

const brief=buildCommentatorBrief(four.find(c=>c.id==="h2h-total"),game);
assert.equal(brief.group,"ЛИЧНЫЕ ВСТРЕЧИ");
assert.ok(brief.points.length>=4&&brief.points.length<=5);
assert.ok(brief.points.some(p=>p.label==="ЦИФРА"&&/5 из 6/.test(p.text)));
assert.ok(brief.points.some(p=>p.label==="ОЧНЫЕ МАТЧИ"));
assert.ok(brief.points.some(p=>p.label==="ЛИНИЯ"&&/1\.91/.test(p.text)));
assert.ok(!brief.points.some(p=>/AIR SCORE|IMPLIED|СТАТИСТИЧЕСКИЙ SCORE/i.test(p.text)));
assert.equal(brief.support_note,"ЕЩЁ 2 ФАКТА В ОПИСАНИИ");
assert.deepEqual(brief.supporting_facts,["ФЛОРИДА ЗАБИВАЛА 3+ В 5 ИЗ 6","КАРОЛИНА ПРОПУСКАЛА 3+ В 4 ИЗ 6"]);
assert.ok(!brief.points.some(p=>/подтверждени/i.test(p.text)),"commentator brief must not use generic confirmation language");
console.log("BROADCAST_FOUR_CARD_SELECTOR_OK");
