import { strict as assert } from 'node:assert';
import { annotateAirUtility, broadcastCardSemanticsValid } from '../cloudflare-worker/src/betting-insight-engine.js';

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
},{away_tri:'NYR',home_tri:'BOS'});
const huge=annotateAirUtility({
  score:78,
  title:'Большая историческая выборка',
  evidence:{sample:216,hits:147,hit_rate:147/216},
  market:{type:'game_total',side:'over',line:5.5,label:'ТБ 5.5',odds:1.70,odds_is_demo:false,odds_source:'provider_live'}
});

assert.ok(bostonHome.air_score>safeHandicap.air_score,'good price + 14/20 must outrank low-price 59/80');
assert.ok(safeHandicap.broadcast_title.includes('59 ИЗ 80'),'80-game sample must expose exact hit count');
assert.ok(safeHandicap.broadcast_title.startsWith('BOS НЕ ПРОИГРЫВАЛ В 2+ ШАЙБЫ'),'positive +1.5 handicap should be human-readable');
assert.equal(splitTotal.broadcast_math_valid,false,'two venue splits must not become an exact market frequency');
assert.equal(splitTotal.broadcast_detail,'NYR в гостях 17/20 · BOS дома 13/20','combined split keeps readable team-level detail');
assert.ok(huge.broadcast_title.includes('147 ИЗ 216'),'large samples must expose exact numerator and denominator');
assert.match(bostonHome.broadcast_title,/14 ИЗ 20/,'<=30 non-handicap samples must keep exact count');
const shortHandicap=annotateAirUtility({
  score:82,
  title:'CAR закрыла фору -1.5 в 14 из последних 20 матчей',
  evidence:{sample:20,hits:14,hit_rate:0.70},
  market:{type:'handicap',subject:'CAR',side:'CAR',line:-1.5,label:'CAR -1.5',odds:2.05,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(shortHandicap.broadcast_title,'CAR ПОБЕЖДАЛ В 2+ ШАЙБЫ — 14 ИЗ 20 МАТЧЕЙ','short handicap sample should keep count but use plain language');
assert.equal(bostonHome.air_meta.meaning,'editorial_broadcast_utility_not_probability');
const floridaMismatch=annotateAirUtility({
  score:96,
  title:'FLA победила в 69% матчей · 140 игр',
  evidence:{sample:140,hits:71,hit_rate:0.69},
  market:{type:'moneyline',subject:'FLA',side:'FLA',label:'Победа FLA',odds:2.00,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(floridaMismatch.air_meta.stats_verified,true);
assert.equal(floridaMismatch.air_meta.stats_rate_corrected,true,'reported 69% must be corrected by exact 71/140');
assert.equal(floridaMismatch.air_meta.stats_hits,71);
assert.equal(floridaMismatch.air_meta.sample_size,140);
assert.equal(floridaMismatch.air_meta.historical_rate,0.507);
assert.match(floridaMismatch.broadcast_title,/71.*140/,'71/140 must display the exact numerator and denominator');
assert.ok(!floridaMismatch.broadcast_title.includes('69%'));
const floridaTraceable=annotateAirUtility({
  score:96,title:'FLA победила 71 из 140',
  evidence:{sample:140,hits:71,hit_rate:71/140,game_pks:Array.from({length:140},(_,i)=>10000+i)},
  market:{type:'moneyline',subject:'FLA',side:'FLA',label:'Победа FLA',odds:2.00,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(floridaTraceable.broadcast_math_valid,true,'large sample is allowed only when every game is traceable');
assert.equal(floridaTraceable.air_meta.historical_rate,0.507);
assert.equal(floridaMismatch.broadcast_math_valid,false,'140-game claim without 140 unique game ids must not enter the broadcast queue');

const unpairedPercent=annotateAirUtility({
  score:96,
  title:'ПОБЕДА — В 69% МАТЧЕЙ · 100+ ИГР',
  evidence:{sample:140,hit_rate:0.69},
  market:{type:'moneyline',subject:'FLA',side:'FLA',label:'Победа FLA',odds:2.00,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(unpairedPercent.air_meta.stats_verified,false);
assert.equal(unpairedPercent.broadcast_math_valid,false,'percentage copy without exact hits/sample must not enter broadcast queue');
const syntheticFlorida=annotateAirUtility({
  score:99,title:'ПОБЕДА — В 69% МАТЧЕЙ · 100+ ИГР',
  evidence:{away:{hits:40,sample:70,hit_rate:40/70},home:{hits:56,sample:70,hit_rate:56/70}},
  market:{type:'moneyline',period:'GAME',subject:'FLA',side:'FLA',label:'ПОБЕДА FLA',odds:2.00,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(syntheticFlorida.air_meta.stats_source,'away+home');
assert.equal(syntheticFlorida.broadcast_math_valid,false,'combined venue samples cannot become Florida win-rate copy');
assert.doesNotMatch(String(floridaMismatch.broadcast_title),/100\+ ИГР|69%/);
assert.equal(broadcastCardSemanticsValid({
  broadcast_math_valid:true,broadcast_title:'ВАНКУВЕР — 5 ИЗ 7 ПРОТИВ ВАНКУВЕР',
  evidence:{split:'h2h',team:'VAN',opponent:'VAN'},
  market:{type:'handicap',period:'P1',subject:'VAN',side:'VAN',line:0,label:'1-Й ПЕРИОД · ВАНКУВЕР · ФОРА 0'}
},{home_tri:'EDM',away_tri:'VAN'}),false,'team cannot be its own H2H opponent');
assert.equal(broadcastCardSemanticsValid({
  broadcast_math_valid:true,broadcast_title:'3-Й ПЕРИОД: ФЛОРИДА — 7 ИЗ 10',
  evidence:{team:'FLA'},market:{type:'period_1_result',period:'P1',subject:'FLA',label:'1-Й ПЕРИОД · ПОБЕДА FLA'}
},{home_tri:'CAR',away_tri:'FLA'}),false,'TV period must match the actual Winline market period');
assert.equal(broadcastCardSemanticsValid({
  broadcast_math_valid:true,broadcast_title:'2-Й ПЕРИОД: ФЛОРИДА — 7 ИЗ 10',
  evidence:{sample:10,hits:7,game_pks:Array.from({length:10},(_,i)=>20000+i),exact_provider_line:true,period_data_verified:false},
  market:{type:'period_2_result',period:'P2',subject:'FLA',label:'2-Й ПЕРИОД · ПОБЕДА FLA'}
},{home_tri:'CAR',away_tri:'FLA'}),false,'historical period trend must have an independent period_scores cross-check');
console.log('BROADCAST_AIR_SCORE_OK',JSON.stringify({
  bostonHome:bostonHome.air_score,
  safeHandicap:safeHandicap.air_score,
  splitTotal:splitTotal.air_score,
  huge:huge.air_score
}));


const nestedCoverWithNulls=annotateAirUtility({
  score:84,
  title:'BUF закрыл фору +1.5 в 59 из последних 80 матчей',
  evidence:{
    window:80,
    hit_rate:null,
    average_rate:null,
    combined_rate:null,
    rate:null,
    cover:{hits:59,sample:80,hit_rate:59/80},
  },
  market:{type:'handicap',subject:'BUF',side:'BUF',line:1.5,label:'BUF +1.5',odds:1.49,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(nestedCoverWithNulls.air_meta.historical_rate,0.738,'null evidence fields must not collapse to zero');
assert.equal(nestedCoverWithNulls.broadcast_math_valid,false,'supporting cover stats cannot masquerade as exact selected-market history');
assert.ok(nestedCoverWithNulls.broadcast_title.startsWith('BUF НЕ ПРОИГРЫВАЛ В 2+ ШАЙБЫ'),'positive handicap headline should name the team');
console.log('BROADCAST_NESTED_COVER_RATE_OK',nestedCoverWithNulls.broadcast_title);


const advancedNoRate=annotateAirUtility({
  score:94,
  category:'advanced_rolling_venue',
  title:'CAR — №2 НХЛ ПО xGF/60 ЗА СЕЗОН И №3 ЗА ПОСЛЕДНИЕ 20; FLA — 28-Й ПО xGA/60',
  evidence:{
    sample:82,
    team:'CAR',
    opponent:'FLA',
    metric:'xgf60',
    opponent_metric:'xga60',
    team_rank:2,
    opponent_rank:28,
    rolling_team_rank_20:3,
    rolling_opponent_rank_20:30,
    rolling_team_rank_10:2,
    rolling_opponent_rank_10:29,
    venue_sample:10,
    venue_confirmed:true,
    multi_window_confirmed:true,
    advanced_snapshot:true,
    feature_layer:'advanced_rolling_venue_v1'
  },
  market:{type:'moneyline',subject:'CAR',side:'CAR',odds:1.79,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(advancedNoRate.air_meta.historical_rate,null,'advanced rank story must not invent historical hit rate');
assert.equal(advancedNoRate.broadcast_title,'CAR — ТОП-2 НХЛ ПО ОПАСНЫМ МОМЕНТАМ');
assert.ok(!advancedNoRate.broadcast_title.includes('0%'),'advanced story must never be rewritten to 0%');
assert.match(advancedNoRate.broadcast_detail,/Последние 20: CAR №3 · FLA №30/);
assert.match(advancedNoRate.broadcast_detail,/Home\/away подтверждает/);
assert.ok(Array.isArray(advancedNoRate.operator_narrative?.details)&&advancedNoRate.operator_narrative.details.length>=4,'operator layer must retain expanded advanced context');
assert.match(advancedNoRate.operator_narrative.details.join(' '),/FLA: 28-е место/,'operator layer must compare opponent rank');
assert.equal(advancedNoRate.operator_narrative.raw.metric_name,'xGF/60','operator layer must retain raw team metric');
assert.equal(advancedNoRate.operator_narrative.raw.opponent_metric_name,'xGA/60','operator layer must retain raw opponent metric');
assert.match(advancedNoRate.operator_narrative.details.join(' '),/Что означает метрика:/,'operator layer must explain advanced jargon');

const missingHistoricalRate=annotateAirUtility({
  score:92,
  category:'history',
  title:'CAR — сезонный профиль',
  evidence:{sample:82},
  market:{type:'moneyline',subject:'CAR',side:'CAR',odds:1.79,odds_is_demo:false,odds_source:'provider_live'}
});
assert.equal(missingHistoricalRate.air_meta.historical_rate,null);
assert.equal(missingHistoricalRate.broadcast_title,'CAR — СЕЗОННЫЙ ПРОФИЛЬ');
assert.ok(missingHistoricalRate.air_score<90,'large sample without hit rate must not receive elite AIR score');
console.log('BROADCAST_ADVANCED_HEADLINE_NULL_RATE_OK',advancedNoRate.broadcast_title);

const localizedAdvanced=annotateAirUtility({
  score:94,
  category:'advanced_market',
  title:'CAR — №2 NHL ПО xGF/60',
  evidence:{sample:82,team:'CAR',opponent:'FLA',metric:'xgf60',opponent_metric:'xga60',team_rank:2,opponent_rank:28,advanced_snapshot:true},
  market:{type:'moneyline',subject:'CAR',side:'CAR',odds:1.79,odds_is_demo:false,odds_source:'provider_live'}
},{
  home_tri:'CAR',away_tri:'FLA',home_name_ru:'Каролина',away_name_ru:'Флорида'
});
assert.match(localizedAdvanced.broadcast_title,/КАРОЛИНА/,'TV layer must use Russian team name when game metadata provides it');
assert.ok(!/\bCAR\b/.test(localizedAdvanced.broadcast_title),'TV headline must not expose tri-code when Russian display name is available');
assert.ok(localizedAdvanced.broadcast_angle_variants.every(x=>!/\bCAR\b|\bFLA\b/.test(String(x.title||''))),'all operator-selectable TV variants must localize team names');
assert.equal(localizedAdvanced.operator_narrative.raw.team_code,'CAR','operator raw layer must keep machine team code');
assert.match(localizedAdvanced.operator_narrative.details.join(' '),/КАРОЛИНА/,'commentator prose should use Russian display name');

const providerWithoutOfficial={
  broadcast_math_valid:true,broadcast_title:'ЧИКАГО — 38 ПОБЕД В 40 МАТЧАХ',
  timing:'pregame',
  evidence:{sample:40,hits:38,game_pks:Array.from({length:40},(_,i)=>30000+i),exact_provider_line:true,period_data_verified:true,official_score_verified:false},
  market:{type:'moneyline',period:'REG',subject:'CHI',side:'CHI',label:'60 МИНУТ · ПОБЕДА CHI'}
};
assert.equal(broadcastCardSemanticsValid(providerWithoutOfficial,{home_tri:'VGK',away_tri:'CHI'}),false,'exact provider frequency must have an independent official-score crosscheck');
const verifiedProvider={...providerWithoutOfficial,evidence:{...providerWithoutOfficial.evidence,official_score_verified:true}};
assert.equal(broadcastCardSemanticsValid(verifiedProvider,{home_tri:'VGK',away_tri:'CHI'}),true,'official-score-verified exact provider history may pass semantic validation');
