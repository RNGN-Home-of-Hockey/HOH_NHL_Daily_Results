import { strict as assert } from 'node:assert';
import { annotateAirUtility } from '../cloudflare-worker/src/betting-insight-engine.js';

const bostonHome=annotateAirUtility({
  score:80,
  title:'BOS выиграл 14 из последних 20 матчей дома',
  evidence:{sample:20,hits:14,hit_rate:0.70,role:'дома'},
  market:{type:'moneyline',subject:'BOS',side:'BOS',label:'Победа BOS',odds:1.76,odds_is_demo:false,odds_source:'provider_live'}
});
const safeHandicap=annotateAirUtility({
  score:88,
  title:'BOS закрыл фору +1.5 в 59 из последних 80 матчей',
  evidence:{sample:80,hits:59,hit_rate:59/80},
  market:{type:'handicap',subject:'BOS',side:'BOS',line:1.5,label:'BOS +1.5',odds:1.28,odds_is_demo:false,odds_source:'provider_live'}
});
const splitTotal=annotateAirUtility({
  score:84,
  title:'NYR в гостях и BOS дома: ТБ 4.5 — 17/20 и 13/20',
  evidence:{away:{hits:17,sample:20,hit_rate:0.85},home:{hits:13,sample:20,hit_rate:0.65}},
  market:{type:'game_total',side:'over',line:4.5,label:'ТБ 4.5',odds:1.38,odds_is_demo:false,odds_source:'provider_live'}
});
const huge=annotateAirUtility({
  score:78,
  title:'Большая историческая выборка',
  evidence:{sample:216,hits:147,hit_rate:147/216},
  market:{type:'game_total',side:'over',line:5.5,label:'ТБ 5.5',odds:1.70,odds_is_demo:false,odds_source:'provider_live'}
});

assert.ok(bostonHome.air_score>safeHandicap.air_score,'good price + 14/20 must outrank low-price 59/80');
assert.ok(safeHandicap.broadcast_title.includes('74%'),'80-game sample should be percentage-first');
assert.ok(safeHandicap.broadcast_title.includes('80 ИГР'),'80-game exact sample should stay visible');
assert.ok(splitTotal.broadcast_title.includes('75%'),'two 20-game venue splits should become one combined percentage');
assert.ok(huge.broadcast_title.includes('200+ ИГР'),'100+ samples should use rounded scale');
assert.equal(bostonHome.broadcast_title,'BOS выиграл 14 из последних 20 матчей дома','<=30 samples stay as natural counts');
assert.equal(bostonHome.air_meta.meaning,'editorial_broadcast_utility_not_probability');
console.log('BROADCAST_AIR_SCORE_OK',JSON.stringify({
  bostonHome:bostonHome.air_score,
  safeHandicap:safeHandicap.air_score,
  splitTotal:splitTotal.air_score,
  huge:huge.air_score
}));
