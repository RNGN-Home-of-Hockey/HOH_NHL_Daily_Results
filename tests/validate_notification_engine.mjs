import assert from 'node:assert/strict';
import { runLiveNotificationTick } from '../cloudflare-worker/src/telegram-live-notifications.js';

const GAME_PK = 2026020001;
const SCORER = 8470001;
const ASSIST = 8470002;

class FakeStatement {
  constructor(db, sql) { this.db=db; this.sql=sql; this.args=[]; }
  bind(...args) { this.args=args; return this; }
  async all() {
    if (this.sql.includes('FROM subscriptions s')) {
      return {results:[
        {subscription_id:1,telegram_user_id:101,subject_type:'team',subject_key:'WSH',notify_pregame:1,notify_start:1,notify_goal:1,notify_assist:0,notify_period_end:1,notify_final:1},
        {subscription_id:2,telegram_user_id:202,subject_type:'player',subject_key:String(ASSIST),notify_pregame:0,notify_start:0,notify_goal:0,notify_assist:1,notify_period_end:0,notify_final:0},
        {subscription_id:3,telegram_user_id:303,subject_type:'player',subject_key:String(SCORER),notify_pregame:0,notify_start:0,notify_goal:1,notify_assist:0,notify_period_end:0,notify_final:0},
      ]};
    }
    if (this.sql.includes('SELECT player_id,current_team_tri FROM players')) {
      return {results:[
        {player_id:ASSIST,current_team_tri:'WSH'},
        {player_id:SCORER,current_team_tri:'WSH'},
      ]};
    }
    throw new Error('Unexpected all() SQL: '+this.sql);
  }
  async first() {
    if (this.sql.includes('FROM live_notification_cursors')) {
      return {game_pk:GAME_PK,last_sort_order:10,last_game_state:'LIVE',last_period:1};
    }
    throw new Error('Unexpected first() SQL: '+this.sql);
  }
  async run() { throw new Error('dry-run fixture should not write D1'); }
}
class FakeDB { prepare(sql){ return new FakeStatement(this,sql); } }

const scheduleGame = {
  id:GAME_PK,
  gameDate:'2026-10-10',
  startTimeUTC:'2026-10-10T17:00:00Z',
  gameState:'LIVE',
  homeTeam:{id:15,abbrev:'WSH',score:2},
  awayTeam:{id:5,abbrev:'PIT',score:1},
};
const pbp = {
  id:GAME_PK,
  homeTeam:{id:15,abbrev:'WSH'},
  awayTeam:{id:5,abbrev:'PIT'},
  periodDescriptor:{number:2},
  rosterSpots:[
    {playerId:SCORER,firstName:{default:'Alex'},lastName:{default:'Goal'},teamId:15},
    {playerId:ASSIST,firstName:{default:'Sam'},lastName:{default:'Assist'},teamId:15},
  ],
  plays:[
    {sortOrder:8,typeDescKey:'faceoff',periodDescriptor:{number:1}},
    {sortOrder:20,typeDescKey:'goal',periodDescriptor:{number:2},details:{eventOwnerTeamId:15,scoringPlayerId:SCORER,assist1PlayerId:ASSIST,homeScore:2,awayScore:1}},
    {sortOrder:30,typeDescKey:'period-end',periodDescriptor:{number:2},details:{}},
  ],
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const value=String(url);
  if (value.includes('/schedule/2026-10-10')) return new Response(JSON.stringify({games:[scheduleGame]}),{status:200});
  if (value.includes('/schedule/2026-10-09') || value.includes('/schedule/2026-10-11')) return new Response(JSON.stringify({games:[]}),{status:200});
  if (value.includes(`/gamecenter/${GAME_PK}/play-by-play`)) return new Response(JSON.stringify(pbp),{status:200});
  throw new Error('Unexpected fetch '+value);
};

try {
  const result = await runLiveNotificationTick({DB:new FakeDB(),TELEGRAM_BOT_TOKEN:'fixture'}, {dryRun:true,now:'2026-10-10T17:12:00Z'});
  assert.equal(result.ok,true);
  assert.equal(result.relevant_games,1);
  assert.equal(result.failed,0);

  const planned=result.events.filter(e=>e.user_id);
  assert.ok(planned.some(e=>e.type==='start'&&e.user_id===101),'team start notification missing');
  assert.ok(planned.some(e=>e.type==='goal'&&e.user_id===101),'team goal notification missing');
  assert.ok(planned.some(e=>e.type==='goal'&&e.user_id===202),'player assist notification missing');
  assert.ok(planned.some(e=>e.type==='goal'&&e.user_id===303),'player goal notification missing');
  assert.ok(planned.some(e=>e.type==='period_end'&&e.user_id===101),'period-end notification missing');
  assert.ok(!planned.some(e=>e.type==='start'&&e.user_id===202),'player with start disabled received start');
  assert.equal(result.initialized_cursors,0);
  assert.equal(result.advanced_cursors,0,'dry-run must not advance cursor');
  console.log('TELEGRAM_NOTIFICATION_ENGINE_OK', {planned:result.planned,events:planned.length});
} finally {
  globalThis.fetch=realFetch;
}
