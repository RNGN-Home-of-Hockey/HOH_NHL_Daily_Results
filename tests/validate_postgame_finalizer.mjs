import { strict as assert } from "node:assert";
import { advancedCoverageStatus,summarizeWinlineLifecycleRows } from "../cloudflare-worker/src/postgame-finalizer.js";

const start="2026-10-10T23:00:00Z";
const rows=[
  {winline_market_id:"m1",winline_event_id:"e1",market_type:"team_total:3.5",subject_type:"team",subject_key:"COL",outcome_name:"Over",odds:1.83,captured_at:"2026-10-10T12:00:00Z"},
  {winline_market_id:"m1",winline_event_id:"e1",market_type:"team_total:3.5",subject_type:"team",subject_key:"COL",outcome_name:"Over",odds:1.91,captured_at:"2026-10-10T20:00:00Z"},
  {winline_market_id:"m1",winline_event_id:"e1",market_type:"team_total:3.5",subject_type:"team",subject_key:"COL",outcome_name:"Over",odds:1.87,captured_at:"2026-10-10T22:55:00Z"},
  {winline_market_id:"m1",winline_event_id:"e1",market_type:"team_total:3.5",subject_type:"team",subject_key:"COL",outcome_name:"Over",odds:2.10,captured_at:"2026-10-10T23:05:00Z"},
  {winline_market_id:"m2",winline_event_id:"e1",market_type:"main_1x2_regular",subject_type:"team",subject_key:"COL",outcome_name:"1",odds:2.20,captured_at:"2026-10-10 21:00:00"},
];
const lifecycle=summarizeWinlineLifecycleRows(rows,start);
assert.equal(lifecycle.length,2);
const m1=lifecycle.find(x=>x.winline_market_id==="m1");
assert.equal(m1.opening_odds,1.83);
assert.equal(m1.closing_odds,1.87,"post-start price must be excluded");
assert.equal(m1.min_odds,1.83);
assert.equal(m1.max_odds,1.91);
assert.equal(m1.snapshot_count,3);
assert.equal(m1.odds_change,0.04);
const m2=lifecycle.find(x=>x.winline_market_id==="m2");
assert.equal(m2.opening_odds,2.20);
assert.equal(m2.closing_odds,2.20);
assert.equal(advancedCoverageStatus([]),"pending_external");
assert.equal(advancedCoverageStatus([{xgf_5v5:null,xga_5v5:null}]),"partial");
assert.equal(advancedCoverageStatus([{xgf_5v5:2.1,xga_5v5:1.8},{xgf_5v5:1.8,xga_5v5:2.1}]),"complete");
console.log("POSTGAME_FINALIZER_RULES_OK");
