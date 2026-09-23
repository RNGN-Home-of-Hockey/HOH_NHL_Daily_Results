import { strict as assert } from "node:assert";
import { parseNhlLiveFeed, mapLiveEvents } from "../cloudflare-worker/src/winline-live-feed-maintenance.js";

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
console.log("WINLINE_LIVE_FEED_PARSE_OK");
