import { strict as assert } from "node:assert";
import { evaluateAdvancedRollingVenueInsights } from "../cloudflare-worker/src/advanced-rolling-venue-insights.js";
import { applyWinlineMarkets } from "../cloudflare-worker/src/winline-market-adapter.js";

const game={game_pk:2027020001,away_tri:"COL",home_tri:"TOR",scheduled_start_utc:"2026-10-10T23:00:00Z"};
const current=[
  {team_tri:"COL",window_games:20,advanced_league_teams:32,rank_xgf60_5v5:3,xgf60_5v5:3.12},
  {team_tri:"COL",window_games:10,advanced_league_teams:32,rank_xgf60_5v5:2,xgf60_5v5:3.20},
  {team_tri:"TOR",window_games:20,advanced_league_teams:32,rank_xga60_5v5:31,xga60_5v5:3.20},
  {team_tri:"TOR",window_games:10,advanced_league_teams:32,rank_xga60_5v5:30,xga60_5v5:3.15},
];
const rows=[];
for(let i=0;i<10;i++){
  rows.push({team_tri:"COL",game_pk:1000+i,scheduled_start_utc:`2026-04-${String(20-i).padStart(2,"0")}T00:00:00Z`,is_home:0,toi_5v5_minutes:50,xgf_5v5:2.7,xga_5v5:2.0,shots_for_5v5:27,shots_against_5v5:23});
  rows.push({team_tri:"TOR",game_pk:2000+i,scheduled_start_utc:`2026-04-${String(20-i).padStart(2,"0")}T00:00:00Z`,is_home:1,toi_5v5_minutes:50,xgf_5v5:2.0,xga_5v5:2.9,shots_for_5v5:23,shots_against_5v5:29});
}
const cards=evaluateAdvancedRollingVenueInsights(game,current,rows);
const c=cards.find(x=>x.market.subject==="COL"&&x.market.side==="over"&&x.market.line===3.5);
assert.ok(c,"COL O3.5 rolling+venue card");
assert.match(c.title,/ЗА СЕЗОН/);
assert.match(c.title,/ПОСЛЕДНИЕ 20/);
assert.match(c.explanation,/COL в гостях/);
assert.match(c.explanation,/TOR дома/);
assert.equal(c.evidence.multi_window_confirmed,true);
assert.equal(c.evidence.venue_confirmed,true);
assert.equal(c.evidence.venue_sample,10);

const now="2026-10-10T18:00:00Z";
const priced=applyWinlineMarkets(cards,[{
  provider:"winline",event_id:"evt",market_id:"m",selection_id:"s",
  market_type:"team_total",period:"GAME",subject:"COL",side:"over",line:3.5,
  odds:1.91,status:"open",updated_at:now
}],{now,max_age_ms:300000});
assert.equal(priced.length,1);
assert.equal(priced[0].market.odds,1.91);
assert.equal(priced[0].category,"advanced_rolling_venue");
console.log("ADVANCED_ROLLING_VENUE_OK",priced[0].title);
