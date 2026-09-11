# HOH Market Evaluator V2

Date: 2026-09-11

## Purpose

Stage 2 turns the historical NHL Data Core into market-first broadcast candidates.

The engine evaluates common market lines, chooses the strongest defensible sample, compares teams with the league, adds advanced 5v5 context, evaluates venue and H2H splits, and then consolidates overlapping evidence into a compact operator portfolio.

## Universal market evaluator

File:
`cloudflare-worker/src/universal-market-evaluator.js`

Evaluated markets:

- game totals: 4.5 / 5.5 / 6.5 / 7.5
- team totals: 1.5 / 2.5 / 3.5 / 4.5
- handicaps: -2.5 / -1.5 / +1.5 / +2.5

Rolling windows:

- last 5
- last 10
- last 20

Minimum trend thresholds:

- 5 games: 80%
- 10 games: 70%
- 20 games: 65%

Short samples are intentionally penalized. A stable 20-game trend wins ties against a 5- or 10-game trend.

The evaluator also uses a 90% Wilson lower bound in ranking so a superficially high hit rate on a tiny sample is not treated the same as a longer stable sample.

## Confluence

For team totals the engine can combine two independent signals on the same line:

1. how often the team itself scores above/below the line;
2. how often the opponent allows above/below the same line.

Example candidate:

`CAR ИТБ 2.5 — CAR scored 3+ in 16/20; opponent allowed 3+ in 14/20.`

Confluence candidates receive higher priority than a single-team trend.

## Rolling league ranks

File:
`cloudflare-worker/src/rolling-league-ranks.js`

The rank engine compares the two teams in the selected game with the whole league on identical 5/10/20-game windows.

Current metrics:

- goals for per game
- goals against per game
- goal differential per game
- combined game total
- Corsi%
- Fenwick%
- second-period goal differential

Only top-3 / bottom-3 league ranks become broadcast candidates.

Examples:

- `#1 in NHL in goals over the last 20`
- `#32 of 32 in goals allowed over the last 20`
- `#2 in Corsi over the last 20`

Defensive rank market direction is explicitly tested:

- elite low goals-against -> opponent team total UNDER
- poor high goals-against -> opponent team total OVER

## Advanced 5v5 market context

File:
`cloudflare-worker/src/advanced-market-context.js`

Source table:
`team_game_advanced_features`

Rolling windows:

- last 5
- last 10
- last 20

Current advanced metrics:

- xGF%
- CF%
- FF%
- xGF/60
- xGA/60
- PDO as supporting evidence
- GSAx as supporting evidence

The engine ranks teams league-wide on the same rolling window. It does not emit a separate card for every advanced metric. Instead it combines multiple independent facts into one market context.

Over example:

`CAR: xGF% #1, CF% #1; NYR — xGA/60 #32 -> CAR team total OVER 2.5.`

Under example:

`NYR: xGF% #32, CF% #32; CAR — xGA/60 #1 -> NYR team total UNDER 2.5.`

Advanced context is evidence supporting a market direction, not a claimed standalone probability.

## Venue and H2H market splits

File:
`cloudflare-worker/src/market-split-insights.js`

### Current-venue splits

The away team is evaluated only on its recent away games and the home team only on its recent home games.

Windows:

- 5
- 10
- 20

Markets:

- exact match totals
- exact team totals
- exact handicaps
- moneyline

Example:

`CAR away + NYR home: O5.5 hit in 16/20 and 15/20.`

This becomes independent supporting evidence for the same exact market in the global portfolio.

### H2H exact market evaluation

The evaluator uses the previous meetings of the two current teams from the perspective of one team, avoiding double-counting the same H2H game.

Windows:

- 4
- 6
- 10

H2H has intentionally lower base weight than general rolling team trends because opponent-specific samples are smaller and noisier.

Markets:

- match totals
- both team totals
- both handicaps
- moneyline

The home-team goal and handicap directions are explicitly transformed from the away-team-perspective H2H rows and covered by tests.

## Global insight portfolio

File:
`cloudflare-worker/src/insight-portfolio.js`

The portfolio layer runs after all historical rule families have generated candidates.

If multiple independent engines point to the exact same market, only the strongest card is shown. Other independent categories are stored inside that card as `supporting_signals` and can add a small capped score boost.

Example:

- rolling hit-rate -> CAR ИТБ 2.5
- league rank -> CAR ИТБ 2.5
- advanced xGF context -> CAR ИТБ 2.5
- CAR away split -> CAR ИТБ 2.5
- H2H split -> CAR ИТБ 2.5

Result: one `CAR ИТБ 2.5` card with independent supporting signals, not five duplicate cards.

The portfolio also suppresses adjacent redundant lines and keeps live cards available separately.

Current global limits:

- max 1 game-total direction in the final portfolio
- max 1 team-total direction per team
- max 1 handicap direction per team
- max 2 moneyline candidates
- up to 4 live candidates retained before the historical portfolio is filled
- final Betting Insight Engine output remains capped at 12 cards

## Winline market availability adapter

File:
`cloudflare-worker/src/winline-market-adapter.js`

The engine can now optionally receive normalized provider markets.

Exact match key:

`market_type + period + subject + side + line`

Behavior when provider markets are supplied:

- only markets with an exact key match survive;
- wrong line does not match;
- regulation (`REG`) does not match evidence calculated for full game including OT/SO (`GAME`);
- closed/suspended markets are rejected;
- stale markets are rejected;
- explicit empty provider feed fails closed and produces no provider-backed cards;
- the newest quote is selected when duplicate exact markets are present;
- synthetic DEMO odds are replaced by real provider odds and IDs only after an exact match.

Attached real fields include:

- `provider`
- `event_id`
- `market_id`
- `selection_id`
- `period`
- `odds`
- `updated_at`
- `deeplink`
- `odds_is_demo=false`
- `odds_source=provider_live`

If no provider feed is supplied at all, the current DEMO mode remains unchanged. This lets Broadcast V2 continue working until the real Winline integration is available.

## Safe degradation

`buildBettingInsights()` now runs every Stage 2 data-dependent module through `safeInsightBuild()`.

If a migration/table is temporarily missing or one Stage 2 query fails:

- that module returns no candidates;
- the rest of the Betting Insight Engine continues;
- Broadcast V2 does not fail as a whole.

This is especially important for:

- `team_game_features` from migration 0004;
- `team_game_advanced_features` from migration 0005.

The migrations still must be applied for those features to become active; the fail-safe only prevents a missing feature table from breaking the product.

## Integration

All Stage 2 modules are called directly from:
`cloudflare-worker/src/betting-insight-engine.js`

`buildBettingInsights(db, game, options = {})` now supports optional:

- `options.provider_markets`
- `options.now`
- `options.market_max_age_ms`

Broadcast V2 currently calls it without provider markets, so it remains in DEMO mode. When the Winline feed exists, the same engine can receive normalized live markets without changing the statistical rule modules.

## Tests completed

Validated with deterministic synthetic datasets:

- exact game total candidate generation;
- team-total offense + opponent-defense confluence;
- handicap cover math;
- preference for stable 20-game samples;
- duplicate-line suppression;
- league top-3 / bottom-3 ranking;
- defensive market direction;
- advanced attack-vs-defense context;
- advanced OVER / UNDER market direction;
- 20-game preference in the advanced context layer;
- exact-market consolidation across independent engines;
- supporting-signal score boost/cap;
- global adjacent-line suppression;
- preservation of live cards;
- away/home exact venue splits;
- H2H team-total direction;
- H2H handicap direction;
- exact Winline line match;
- period mismatch rejection;
- stale-market rejection;
- closed-market rejection;
- empty-provider-feed fail-closed behavior;
- DEMO fallback with no provider feed.

Validation found and fixed before production:

- score saturation could leave a shorter sample tied with a longer one; ranking was changed to preserve separation and explicitly prefer the longer sample on ties;
- goals-against league rank originally mapped strong/weak defense to the wrong opponent team-total direction; the mapping was reversed and covered by a dedicated test;
- Stage 2 modules originally could propagate a missing-table D1 error into the whole Broadcast game endpoint; they are now isolated through `safeInsightBuild()`.

The complete Worker import graph passed `wrangler deploy --dry-run` after both the market-split and Winline-adapter integrations.

## Deployment prerequisite

Apply pending D1 migrations before the next production deploy:

```powershell
npx wrangler d1 migrations apply hoh-data-core --remote
```

This safely skips already-applied migrations and applies pending ones such as 0004/0005 if needed.

## Next Stage 2 work

1. production validation of real cards against remote D1 after migrations/deploy;
2. provider ingestion once Winline API/feed credentials or payload examples are available;
3. player/goalie game features and player-vs-opponent splits;
4. own HOH xG from NHL shot coordinates;
5. add more market families such as regulation-only 1X2/total and period totals with settlement semantics kept separate.
