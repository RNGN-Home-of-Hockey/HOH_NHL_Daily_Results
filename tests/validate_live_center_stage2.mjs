import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { buildLiveGameSnapshot, buildLiveCards, buildProviderDrivenLiveCards } from '../cloudflare-worker/src/live-betting-engine.js';

const plays=[];let order=1;
const add=(type,team,minute,extra={})=>plays.push({sortOrder:order++,eventId:order,typeDescKey:type,details:{eventOwnerTeamId:team,...extra},periodDescriptor:{number:1,periodType:'REG'},timeInPeriod:minute});
for(const t of ['03:00','03:40','04:10','04:40','05:10','05:40','06:10','06:40'])add('shot-on-goal',1,t);
for(const t of ['03:20','06:20'])add('shot-on-goal',2,t);
add('goal',1,'06:50');add('hit',1,'07:00');add('hit',2,'07:10');add('penalty',2,'07:20',{duration:2});add('faceoff',1,'07:30');add('faceoff',2,'08:00');
const payload={id:2026020001,season:20262027,gameType:2,gameState:'LIVE',homeTeam:{id:2,abbrev:'ANA',score:1,sog:8},awayTeam:{id:1,abbrev:'FLA',score:1,sog:12},periodDescriptor:{number:1,periodType:'REG'},clock:{timeRemaining:'12:00',secondsRemaining:720,running:true,inIntermission:false},plays};
const fakeFetch=async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
const snap=await buildLiveGameSnapshot(2026020001,fakeFetch);
assert.equal(snap.game.away_score,1);assert.equal(snap.game.home_score,1);assert.equal(snap.live_stats.away.shots,12);assert.equal(snap.live_stats.home.shots,8);assert.equal(snap.live_stats.home.pim,2);assert.equal(snap.live_stats.away.faceoff_pct,0.5);assert.equal(snap.live_context.periods[0].goals_by_team.FLA,1);

const weakGame={...snap.game,home_score:2,away_score:1};const weakShots=[];for(let i=0;i<6;i++)weakShots.push({sort_order:i+1,event_type:'shot-on-goal',team_tri:i<5?'FLA':'ANA',period_number:1,elapsed_seconds:300+i*20});
assert.equal(buildLiveCards(weakGame,weakShots).some(c=>c.market?.type==='moneyline'),false,'shots must never create match-winner card');

const provider=[{provider:'winline',event_id:'1',market_id:'m1',selection_id:'m1',market_type:'moneyline',period:'GAME',subject:'FLA',side:'FLA',line:null,odds:2.9,status:'open',is_live:true,updated_at:new Date().toISOString()}];
const fallback=buildProviderDrivenLiveCards(snap,provider,[],{now:Date.now(),max_age_ms:90000});
assert.equal(fallback.length,0,'shot-based provider fallback must not manufacture moneyline');

const dash=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-dashboard-v2.js',import.meta.url),'utf8');for(const needle of ['applyLiveGameSnapshot(l)','renderMetrics(currentData,l.live_stats||null)','score.innerHTML=esc(g.away_score)'])assert.ok(dash.includes(needle),'dashboard missing '+needle);
const overlay=fs.readFileSync(new URL('../cloudflare-worker/src/broadcast-operator.js',import.meta.url),'utf8');for(const needle of ['statePollUrl()','failures>=12','imageFailures>=4','Date.now()-lastOk>20000'])assert.ok(overlay.includes(needle),'overlay watchdog missing '+needle);
console.log('LIVE_CENTER_STAGE2_V3_OK');
