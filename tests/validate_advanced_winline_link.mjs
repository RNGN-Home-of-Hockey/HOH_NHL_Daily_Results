import { strict as assert } from "node:assert";
import { buildAdvancedTeamSnapshotInsights } from "../cloudflare-worker/src/advanced-team-snapshot-insights.js";
import { selectInsightPortfolio } from "../cloudflare-worker/src/insight-portfolio.js";
import { applyWinlineMarkets } from "../cloudflare-worker/src/winline-market-adapter.js";

const now=new Date().toISOString();
const game={game_pk:2026020997,away_tri:"COL",home_tri:"TOR"};
const raw=buildAdvancedTeamSnapshotInsights(game);
const portfolio=selectInsightPortfolio(raw,12);
const priced=applyWinlineMarkets(portfolio,[{
  provider:"winline",
  event_id:"evt-advanced",
  market_id:"m-team-total",
  selection_id:"sel-col-over-35",
  market_type:"team_total",
  period:"GAME",
  subject:"COL",
  side:"over",
  line:3.5,
  odds:1.87,
  status:"open",
  updated_at:now
}],{now,max_age_ms:300000});

assert.equal(priced.length,1,"only exact Winline market should survive");
assert.equal(priced[0].market.type,"team_total");
assert.equal(priced[0].market.subject,"COL");
assert.equal(priced[0].market.line,3.5);
assert.equal(priced[0].market.odds,1.87);
assert.equal(priced[0].market.odds_is_demo,false);
assert.match(priced[0].title,/№1 НХЛ ПО БРОСКАМ/);
assert.equal(priced[0].category,"advanced_market");
console.log("ADVANCED_WINLINE_LINK_OK",priced[0].title,priced[0].market.odds);
