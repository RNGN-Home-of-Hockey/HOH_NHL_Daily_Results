import { strict as assert } from "node:assert";
import { buildAdvancedTeamSnapshotInsights } from "../cloudflare-worker/src/advanced-team-snapshot-insights.js";
import { selectInsightPortfolio } from "../cloudflare-worker/src/insight-portfolio.js";
import { applyWinlineMarkets } from "../cloudflare-worker/src/winline-market-adapter.js";

const now=new Date().toISOString();
const game={game_pk:2026020997,away_tri:"COL",home_tri:"TOR"};
const raw=buildAdvancedTeamSnapshotInsights(game);
const matched=applyWinlineMarkets(raw,[{
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
const portfolio=selectInsightPortfolio(matched,12);

assert.equal(matched.length,1,"only exact Winline market should survive matching");
assert.equal(portfolio.length,1,"exact Winline line should survive portfolio pruning");
assert.equal(portfolio[0].market.type,"team_total");
assert.equal(portfolio[0].market.subject,"COL");
assert.equal(portfolio[0].market.line,3.5);
assert.equal(portfolio[0].market.odds,1.87);
assert.equal(portfolio[0].market.odds_is_demo,false);
assert.match(portfolio[0].title,/№1 НХЛ ПО БРОСКАМ/);
assert.equal(portfolio[0].category,"advanced_market");

const directOverContext=selectInsightPortfolio([
  {
    id:"context-car",category:"market_combination",score:99,title:"CAR — №2 НХЛ ПО БАЛАНСУ МОМЕНТОВ",
    evidence:{team:"CAR",opponent:"FLA",metric:"xgd60",team_rank:2,opponent_rank:18,market_combination:true,target_market_frequency_verified:false},
    market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.78,odds_is_demo:false,odds_source:"provider_live"}
  },
  {
    id:"home-car",category:"venue_split",score:80,title:"CAR выиграла 16 из последних 20 матчей дома",
    evidence:{team:"CAR",split:"current_venue",role:"дома",window:20,sample:20,decisions:20,hits:16,hit_rate:.8},
    market:{type:"moneyline",period:"GAME",subject:"CAR",side:"CAR",line:null,odds:1.78,odds_is_demo:false,odds_source:"provider_live"}
  }
],12);
assert.equal(directOverContext.length,1);
assert.equal(directOverContext[0].category,"venue_split","verified 16/20 home form should lead the same market over generic advanced context");
assert.match(directOverContext[0].title,/16 из последних 20 матчей дома/i);
assert.ok((directOverContext[0].evidence?.supporting_signals||[]).some(x=>x.category==="market_combination"),"advanced context should remain available as supporting evidence");

console.log("ADVANCED_WINLINE_LINK_OK",portfolio[0].title,portfolio[0].market.odds);
