import { strict as assert } from "node:assert";
import { buildAdvancedTeamSnapshotInsights,advancedMetricRank } from "../cloudflare-worker/src/advanced-team-snapshot-insights.js";

assert.equal(advancedMetricRank("COL","s","sf60","desc"),1,"COL should rank #1 in shots/60 in 2025/26 snapshot");
assert.equal(advancedMetricRank("CAR","s","cf_pct","desc"),1,"CAR should rank #1 in Corsi share");

const game={game_pk:2026020998,away_tri:"COL",home_tri:"TOR"};
const cards=buildAdvancedTeamSnapshotInsights(game);
assert.ok(cards.length>0);
const colOver=cards.find(c=>c.market.type==="team_total"&&c.market.subject==="COL"&&c.market.side==="over"&&c.market.line===3.5);
assert.ok(colOver,"COL team-total over context must exist");
assert.match(colOver.title,/COL/);
assert.match(colOver.title,/№1 НХЛ ПО БРОСКАМ/);
assert.match(colOver.title,/TOR/,"best team-total story should combine COL attack with TOR defense");
assert.match(colOver.title,/ДОПУЩЕННЫМ БРОСКАМ/,"shot-volume mismatch should be explicit");
assert.equal(colOver.evidence.role,"attack_defense_mismatch");
assert.equal(colOver.category,"advanced_market");
assert.equal(colOver.evidence.sample,82);
assert.equal(colOver.evidence.source,"user_supplied_advanced_team_csv");

const colMoneyline=cards.find(c=>c.market.type==="moneyline"&&c.market.subject==="COL");
assert.ok(colMoneyline,"dominant team should get moneyline advanced context");
assert.match(colMoneyline.title,/COL/);
assert.ok(colMoneyline.score>=84);

console.log("ADVANCED_TEAM_SNAPSHOT_INSIGHTS_OK",JSON.stringify({
  cards:cards.length,
  team_total:colOver.title,
  moneyline:colMoneyline.title
}));