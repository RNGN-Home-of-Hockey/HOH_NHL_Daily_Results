import { strict as assert } from "node:assert";
import { getWinlineLiveFeedMaintenanceStatus, parseNhlLiveFeed, mapLiveEvents } from "../cloudflare-worker/src/winline-live-feed-maintenance.js";
import { cadenceFor } from "../cloudflare-worker/src/winline-feed-maintenance.js";

const xml=`<Root><Sport Id="4"><Country Id="1"><Tournament Id="nhl" Name="NHL"><Match Id="9001" Team1="Carolina Hurricanes" Team2="Florida Panthers" MatchDate="2026-10-10T00:00:00Z" MatchUrl="https://winline.ru/match/9001"><line freetext="Next Goal" name1="1" odd1="1.91" name2="2" odd2="2.05"/><line freetext="Total" value="5.5" name1="Over" odd1="1.85" name2="Under" odd2="1.95"/></Match></Tournament></Country></Sport></Root>`;
const events=parseNhlLiveFeed(xml);
assert.equal(events.length,1);
assert.equal(events[0].team1_tri,"CAR");
assert.equal(events[0].team2_tri,"FLA");
assert.equal(events[0].lines.length,2);
const mapped=mapLiveEvents(events,[{game_pk:2026020001,home_tri:"CAR",away_tri:"FLA",game_state:"LIVE",scheduled_start_utc:"2026-10-10T00:00:00Z"}]);
assert.equal(mapped.length,1);
assert.equal(mapped[0].game_pk,2026020001);
assert.equal(mapped[0].team1_is_home,true);
const now=Date.parse("2026-10-10T00:00:00Z");
assert.equal(cadenceFor("2026-10-12T00:00:00Z",now)/60000,360);
assert.equal(cadenceFor("2026-10-10T08:00:00Z",now)/60000,60);
assert.equal(cadenceFor("2026-10-10T02:00:00Z",now)/60000,15);
assert.equal(cadenceFor("2026-10-10T00:30:00Z",now)/60000,5);

class StatusStmt{
  constructor(sql){this.sql=sql}
  bind(){return this}
  async first(){
    if(this.sql.includes("data_core_meta"))return {meta_value:JSON.stringify({fetched_at:"2026-10-09T23:59:30.000Z",mapped_events:1,markets_written:12})};
    return null;
  }
  async all(){
    if(this.sql.includes("FROM games"))return {results:[{game_pk:2026020001,scheduled_start_utc:"2026-10-10T00:00:00Z",game_state:"LIVE",home_tri:"CAR",away_tri:"FLA"}]};
    return {results:[]};
  }
}
const status=await getWinlineLiveFeedMaintenanceStatus({DB:{prepare:sql=>new StatusStmt(sql)}},{nowMs:now});
assert.equal(status.ok,true);
assert.equal(status.candidate_games,1);
assert.equal(status.last_fetch_age_seconds,30);
assert.equal(status.healthy,true);
assert.equal(status.cadence_target_seconds,60);
assert.equal(status.quote_max_age_seconds,90);

console.log("WINLINE_LIVE_FEED_PARSE_OK");
