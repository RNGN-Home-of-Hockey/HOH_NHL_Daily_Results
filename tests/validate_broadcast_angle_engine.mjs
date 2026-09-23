
import { strict as assert } from "node:assert";
import { buildBroadcastAngles, diversifyBroadcastAngles } from "../cloudflare-worker/src/broadcast-angle-engine.js";

const rankCard={
  title:"CAR advanced xG",
  evidence:{team:"CAR",opponent:"FLA",team_rank:2,opponent_rank:18,metric:"xgf60",sample:82},
  market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",label:"Победа CAR",odds:1.79,odds_is_demo:false}
};
const profile={
  team:"CAR",opponent:"FLA",teamRank:2,opponentRank:18,teamValue:3.21,
  meta:{tv:"СОЗДАННЫМ ОПАСНЫМ МОМЕНТАМ",unit:"xG/60"}
};
const rankAngles=buildBroadcastAngles(rankCard,profile);
assert.ok(rankAngles.length>=3);
assert.ok(rankAngles[0].title.includes("2"),"primary rank angle must keep a number");
assert.ok(rankAngles.some(x=>x.family==="rank_contrast"&&/18/.test(x.title)),"opponent rank contrast must exist");
assert.ok(!/xgf|xga|corsi|fenwick|gsax/i.test(String(rankAngles[0].subtitle||"")),"raw advanced jargon must stay out of the default TV subtitle");
assert.ok(rankAngles.filter(x=>x.family!=="source_fact").every(x=>x.title===x.title.toUpperCase()),"generated TV titles should be uppercase");

const historyCard={
  title:"exact line",
  evidence:{
    hits:8,decisions:10,hit_rate:.8,window:10,current_streak:4,
    trend_windows:[
      {window:10,hits:8,decisions:10,hit_rate:.8,pushes:0},
      {window:20,hits:15,decisions:20,hit_rate:.75,pushes:0},
      {window:40,hits:27,decisions:40,hit_rate:.675,pushes:0}
    ]
  },
  market:{type:"game_total",period:"GAME",subject:null,side:"over",line:5.5,label:"ТБ 5.5",odds:1.91,odds_is_demo:false}
};
const historyAngles=buildBroadcastAngles(historyCard,{});
assert.ok(historyAngles.some(x=>x.family==="hit_rate"&&/8 ИЗ 10/.test(x.title)));
assert.ok(historyAngles.some(x=>x.family==="streak"&&/4 МАТЧА ПОДРЯД/.test(x.title)));
assert.ok(historyAngles.some(x=>x.family==="multi_window"&&/8 ИЗ 10/.test(x.title)&&/15 ИЗ 20/.test(x.title)));
assert.ok(historyAngles.every(x=>/\d/.test(x.title)),"numeric evidence must stay numeric on TV");

const specialCard={
  title:"special teams",
  evidence:{team:"CAR",opponent:"FLA",pp_pct:.27,opponent_pk_pct:.74,sample:10},
  market:{type:"team_total",period:"GAME",subject:"CAR",side:"over",line:2.5,label:"CAR ИТБ 2.5",odds:1.95,odds_is_demo:false}
};
const specialAngles=buildBroadcastAngles(specialCard,{});
assert.ok(specialAngles.some(x=>x.family==="special_teams_pp"&&/27%/.test(x.title)));
assert.ok(specialAngles.some(x=>x.family==="special_teams_pk"&&/74%/.test(x.title)));

const diversified=diversifyBroadcastAngles([
  {id:"a",broadcast_angle_variants:[
    {id:"1",family:"hit_rate",title:"ТБ 5,5 — 8 ИЗ 10",score:100},
    {id:"2",family:"streak",title:"ТБ 5,5 — 4 МАТЧА ПОДРЯД",score:96}
  ]},
  {id:"b",operator_narrative:{headline:"CAR",details:["Почему выбрана эта эфирная подача: точная частота линии.","Другая деталь."],raw:{selected_broadcast_angle:{id:"3"}}},broadcast_angle_variants:[
    {id:"3",family:"hit_rate",title:"CAR ИТБ 2,5 — 8 ИЗ 10",score:100,reason:"точная частота линии"},
    {id:"4",family:"league_rank",title:"CAR — ТОП-2 НХЛ ПО ОПАСНЫМ МОМЕНТАМ",score:98,reason:"место в НХЛ"}
  ]},
  {id:"c",broadcast_angle_variants:[
    {id:"5",family:"hit_rate",title:"CAR ФОРА +1,5 — 9 ИЗ 10",score:100},
    {id:"6",family:"rank_contrast",title:"CAR — №2, FLA — №18 ПО XG",score:98}
  ]}
]);
assert.equal(diversified.length,3);
assert.ok(new Set(diversified.map(x=>x.broadcast_angle_family)).size>=2,"queue must diversify angle families");
const diversifiedB=diversified.find(x=>x.id==="b");
assert.equal(diversifiedB.operator_narrative.raw.selected_broadcast_angle.id,diversifiedB.broadcast_angle_id,"operator explanation must follow diversified TV angle");
assert.ok(diversifiedB.operator_narrative.details[0].includes(diversifiedB.broadcast_angle_reason),"operator reason must describe the chosen TV angle");

const jargonSafe=diversifyBroadcastAngles([
  {id:"advanced",broadcast_angle_variants:[
    {id:"raw",family:"source_fact",title:"CAR — №2 NHL ПО xGF/60",score:999,reason:"raw"},
    {id:"human",family:"league_rank",title:"CAR — ТОП-2 НХЛ ПО СОЗДАННЫМ ОПАСНЫМ МОМЕНТАМ",score:80,reason:"место в НХЛ"}
  ]}
]);
assert.equal(jargonSafe[0].broadcast_angle_id,"human","raw xG/Corsi/Fenwick jargon must never beat an available human TV angle");

const historyDiverse=diversifyBroadcastAngles([
  {id:"fresh",broadcast_angle_variants:[
    {id:"count",family:"hit_rate",title:"ТБ 5,5 — 8 ИЗ 10",score:100,reason:"точная частота линии"},
    {id:"run",family:"streak",title:"ТБ 5,5 ПРОХОДИТ 4 МАТЧА ПОДРЯД",score:96,reason:"серия"}
  ]}
],{recent_headlines:["ТБ 6,5 — 7 ИЗ 10"]});
assert.equal(historyDiverse[0].broadcast_angle_id,"run","recently shown headline shape should yield to a different semantic angle");
console.log("BROADCAST_ANGLE_ENGINE_OK");
