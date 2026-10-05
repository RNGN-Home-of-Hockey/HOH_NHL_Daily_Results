import { strict as assert } from "node:assert";
import { fetchNhlLiveFeedWithFallback, getWinlineLiveFeedMaintenanceStatus, parseNhlLiveFeed, mapLiveEvents } from "../cloudflare-worker/src/winline-live-feed-maintenance.js";
import { cadenceFor } from "../cloudflare-worker/src/winline-feed-maintenance.js";

const xml=`<Root><Sport Id="4"><Country Id="1"><Tournament Id="nhl" Name="NHL"><Match Id="9001" Team1="Carolina Hurricanes" Team2="Florida Panthers" MatchDate="2026-10-10T00:00:00Z" MatchUrl="https://winline.ru/match/9001"><line freetext="Next Goal" name1="1" odd1="1.91" name2="2" odd2="2.05"/><line freetext="Total" value="5.5" name1="Over" odd1="1.85" name2="Under" odd2="1.95"/></Match></Tournament></Country></Sport></Root>`;
const emptyXml=`<Root><Sport Id="4"><Country Id="1"><Tournament Id="nhl" Name="NHL"></Tournament></Country></Sport></Root>`;
const events=parseNhlLiveFeed(xml);
assert.equal(events.length,1);
assert.equal(events[0].team1_tri,"CAR");
assert.equal(events[0].team2_tri,"FLA");
assert.equal(events[0].lines.length,2);
const game={game_pk:2026020001,home_tri:"CAR",away_tri:"FLA",game_state:"LIVE",scheduled_start_utc:"2026-10-10T00:00:00Z"};
const mapped=mapLiveEvents(events,[game]);
assert.equal(mapped.length,1);
assert.equal(mapped[0].game_pk,2026020001);
assert.equal(mapped[0].team1_is_home,true);

const calls=[];
const fallback=await fetchNhlLiveFeedWithFallback(async url=>{
  calls.push(url);
  return {ok:true,status:200,text:async()=>url.endsWith("/liveeng")?xml:emptyXml};
},[game],{timeoutMs:1000});
assert.equal(fallback.mapped.length,1);
assert.equal(fallback.mapped[0].game_pk,2026020001);
assert.equal(fallback.mapped[0].feed_source,"liveeng");
assert.equal(fallback.fallback_used,true);
assert.equal(calls.length,4);
assert.ok(fallback.sources.includes("liveeng"));

const noFallbackCalls=[];
const primary=await fetchNhlLiveFeedWithFallback(async url=>{
  noFallbackCalls.push(url);
  return {ok:true,status:200,text:async()=>xml};
},[game],{timeoutMs:1000});
assert.equal(primary.mapped.length,1);
assert.equal(primary.fallback_used,false);
assert.equal(noFallbackCalls.length,1);

const now=Date.parse("2026-10-10T00:00:00Z");
assert.equal(cadenceFor("2026-10-12T00:00:00Z",now)/60000,360);
assert.equal(cadenceFor("2026-10-10T08:00:00Z",now)/60000,60);
assert.equal(cadenceFor("2026-10-10T02:00:00Z",now)/60000,15);
assert.equal(cadenceFor("2026-10-10T00:30:00Z",now)/60000,5);

class StatusStmt{
  constructor(sql,state,liveGames){this.sql=sql;this.state=state;this.liveGames=liveGames}
  bind(){return this}
  async first(){
    if(this.sql.includes("data_core_meta"))return {meta_value:JSON.stringify(this.state)};
    return null;
  }
  async all(){
    if(this.sql.includes("FROM games"))return {results:this.liveGames};
    return {results:[]};
  }
}
function statusDb(state,liveGames){return {prepare:sql=>new StatusStmt(sql,state,liveGames)}}
const freshState={fetched_at:"2026-10-09T23:59:30.000Z",live_games:1,feed_events:1,mapped_events:1,markets_written:12};
const status=await getWinlineLiveFeedMaintenanceStatus({DB:statusDb(freshState,[game])},{nowMs:now});
assert.equal(status.ok,true);
assert.equal(status.candidate_games,1);
assert.equal(status.last_fetch_age_seconds,30);
assert.equal(status.healthy,true);
assert.equal(status.status,"live_ok");
assert.equal(status.cadence_target_seconds,60);
assert.equal(status.quote_max_age_seconds,90);

const failedAt=Date.parse("2026-10-09T18:00:00Z");
const failedState={fetched_at:new Date(failedAt).toISOString(),live_games:2,feed_events:0,mapped_events:0,markets_written:0};
const postIncident=await getWinlineLiveFeedMaintenanceStatus({DB:statusDb(failedState,[])},{nowMs:now});
assert.equal(postIncident.candidate_games,0);
assert.equal(postIncident.healthy,false);
assert.equal(postIncident.status,"degraded");
assert.equal(postIncident.degraded_reason,"provider_empty");
assert.equal(postIncident.recent_live_incident,true);

const mappingState={fetched_at:"2026-10-09T23:59:30.000Z",live_games:1,feed_events:3,mapped_events:0};
const mappingFailure=await getWinlineLiveFeedMaintenanceStatus({DB:statusDb(mappingState,[game])},{nowMs:now});
assert.equal(mappingFailure.healthy,false);
assert.equal(mappingFailure.degraded_reason,"mapping_empty");

console.log("WINLINE_LIVE_FEED_PARSE_OK");
