# HOH Market Evaluator V2

Date: 2026-09-11

## Purpose

Stage 2 turns the historical NHL Data Core into market-first broadcast candidates.

The engine evaluates common market lines, chooses defensible samples, compares teams with the league, adds advanced 5v5 context, evaluates venue and H2H splits, keeps GAME and REG settlement semantics separate, and consolidates overlapping evidence into a compact operator portfolio.

`score` is an editorial rule score. It is **not** a probability, expected value, or claimed betting edge.

## Universal GAME market evaluator

File:
`cloudflare-worker/src/universal-market-evaluator.js`

Evaluated full-game markets:

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

The evaluator uses a 90% Wilson lower bound so a superficially high hit rate on a tiny sample is not treated like a longer stable sample.

### Team-total confluence

A team-total candidate can combine:

1. how often the team itself scores above/below the exact line;
2. how often the opponent allows above/below the same exact line.

Example:

`CAR ИТБ 2.5 — CAR scored 3+ in 16/20; opponent allowed 3+ in 14/20.`

## Regulation-only evaluator

File:
`cloudflare-worker/src/regulation-market-evaluator.js`

This evaluator uses only:

- `regulation_goals_for`
- `regulation_goals_against`
- P1 + P2 + P3

Overtime and shootout are excluded.

Current REG markets:

- game totals: 4.5 / 5.5 / 6.5
- team totals: 1.5 / 2.5 / 3.5

Rolling windows:

- 5
- 10
- 20

Every card explicitly carries:

`market.period = "REG"`

while the existing full-game evaluator defaults to:

`market.period = "GAME"`

The portfolio exact-market key includes period, so `REG O5.5` and `GAME O5.5` cannot collapse into one card.

The Winline adapter also requires period equality. A provider `REG O5.5` quote cannot attach to GAME evidence, and vice versa.

## Rolling league ranks

File:
`cloudflare-worker/src/rolling-league-ranks.js`

Metrics:

- goals for/game
- goals against/game
- goal differential/game
- combined game total
- Corsi%
- Fenwick%
- second-period goal differential

Windows:

- 5
- 10
- 20

Only top-3 / bottom-3 ranks become candidates.

Examples:

- `#1 NHL in goals over the last 20`
- `#32 in goals allowed over the last 20`
- `#2 in Corsi over the last 20`

Defensive market direction is explicitly tested:

- elite low GA -> opponent team total UNDER
- poor high GA -> opponent team total OVER

After production QC, `league_rank` is treated primarily as contextual evidence. A standalone league-rank card receives a portfolio penalty and cannot crowd the queue with context-only suggestions.

## Advanced 5v5 context

File:
`cloudflare-worker/src/advanced-market-context.js`

Source:
`team_game_advanced_features`

Metrics:

- xGF%
- CF%
- FF%
- xGF/60
- xGA/60
- PDO as supporting evidence
- GSAx as supporting evidence

The engine combines multiple metrics into one market context rather than emitting one card per number.

Example:

`CAR: xGF% #1, CF% #1; opponent xGA/60 #32 -> CAR team total OVER.`

The current gate is intentionally strict. Production diagnostics over the latest playoff sample produced no primary advanced-context cards; the threshold has not been weakened merely to increase card volume. Advanced context remains a candidate supporting layer and will be tuned on a larger regular-season sample.

## Venue and H2H exact market splits

File:
`cloudflare-worker/src/market-split-insights.js`

### Current venue

Away team: away games only.

Home team: home games only.

Windows:

- 5
- 10
- 20

Markets:

- GAME totals
- GAME team totals
- GAME handicaps
- GAME moneyline

### H2H

Previous meetings are queried from one team perspective to avoid counting the same game twice.

Windows:

- 4
- 6
- 10

Markets:

- GAME totals
- GAME team totals
- GAME handicaps
- GAME moneyline

H2H deliberately gets less base weight than broader rolling history because opponent-specific samples are smaller.

Production support diagnostics over 24 recent games found H2H was frequently useful as confirmation rather than as the visible primary card:

- venue supporting signals: 50
- H2H supporting signals: 57

## Unified market contract

Old feature cards and Stage 2 cards now use the same market types:

- `game_total`
- `team_total`
- `handicap`
- `moneyline`

Legacy names such as `game_total_5_5` and `team_total_2_5` were removed from feature-market output.

This matters because the global portfolio can now recognize that two different engines are discussing the same exact market and consolidate them.

## Global insight portfolio

File:
`cloudflare-worker/src/insight-portfolio.js`

Exact market key:

`type + period + subject + side + line`

For each exact market:

1. prefer a direct market signal as the visible primary card;
2. use league-rank / advanced-context signals as context when a direct signal exists;
3. retain independent categories inside `evidence.supporting_signals`;
4. expose `independent_support_count`;
5. suppress redundant neighbouring lines in the final operator queue.

Example inputs:

- rolling hit-rate -> CAR ИТБ 2.5
- venue split -> CAR ИТБ 2.5
- H2H -> CAR ИТБ 2.5
- league rank -> CAR ИТБ 2.5
- advanced xG context -> CAR ИТБ 2.5

Result:

one `CAR ИТБ 2.5` card with independent supporting evidence.

### Evidence tiers

The portfolio now adds `evidence_quality`.

`A`
- direct signal;
- at least two independent supporting categories.

`B`
- direct signal with one independent support; or
- sufficiently strong direct signal with a meaningful sample.

`C`
- single weaker/contextual signal.

`LIVE`
- live-game signal; separate priority path.

The tier means **editorial evidence strength, not outcome probability**.

The original rule `score` is no longer increased just because support exists. Instead the portfolio has a separate `portfolio_score` used only for queue ordering.

### Context policy

`league_rank` and `advanced_context` are marked context categories.

A context-only card:

- receives an ordering penalty;
- must still clear a high source score;
- is limited so context-only cards cannot flood the queue.

### Broad-line editorial penalty

A small presentation penalty is applied to very broad demo lines such as:

- GAME O4.5
- GAME U7.5
- team O1.5
- team U4.5
- +2.5 handicap

This does not change the underlying statistic. It only prevents relatively easy-to-hit but weak editorial lines from dominating the operator queue when a more meaningful exact line has comparable evidence.

## Broadcast evidence badge

Broadcast V2 now renders evidence tier next to the insight eyebrow:

- `A · +N`
- `B · +N`
- `C`

`+N` is the number of independent supporting categories.

The tooltip explicitly states that this is evidence strength, not probability.

No automated SHOW behavior was added. Final on-air display remains manual.

## Winline market availability adapter

File:
`cloudflare-worker/src/winline-market-adapter.js`

Optional input to:

`buildBettingInsights(db, game, options = {})`

- `options.provider_markets`
- `options.now`
- `options.market_max_age_ms`

Provider exact-match key:

`market_type + period + subject + side + line`

When provider markets are supplied:

- wrong line -> rejected
- wrong period -> rejected
- closed/suspended -> rejected
- stale quote -> rejected
- explicit empty provider feed -> fail closed
- newest exact duplicate -> selected
- exact match -> DEMO odds replaced with real provider IDs/odds/deeplink

Real attached fields include:

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

With no provider feed, existing DEMO behavior remains available for product testing.

## Safe degradation

All data-dependent Stage 2 modules run through `safeInsightBuild()`.

If one module/table/query fails:

- that module returns no candidates;
- other insight families still run;
- Broadcast game endpoint does not fail as a whole.

Relevant feature tables:

- migration 0004 -> `team_game_features`
- migration 0005 -> `team_game_advanced_features`

## Production validation

A read-only smoke test against the deployed Worker confirmed:

- 2792 historical REG/playoff games in remote D1
- 32 teams
- Stage 2 cards returned by real game endpoints
- real categories included `market_evaluator`, `league_rank`, `venue_split`
- exact markets already carried multiple supporting signals on production history

### Retrospective QC sample

A read-only retrospective QA run evaluated the latest 40 historical games. Each game endpoint generated pregame cards from history dated before that game, then the settleable GAME markets were compared with the final result.

This was a small, playoff-heavy QA sample. It is **not** a future probability estimate and should not be used as a claimed betting edge.

Observed QA hit rates:

By category:

- universal `market_evaluator`: 69/90 = 76.7%
- `venue_split`: 28/37 = 75.7%
- legacy `feature`: 13/22 = 59.1%
- `history`: 15/26 = 57.7%
- `league_rank`: 37/83 = 44.6%
- legacy `matchup`: 2/5 = 40.0%

By independent support count:

- no support: 54/106 = 50.9%
- one support: 62/95 = 65.3%
- two or more supports: 48/62 = 77.4%

By market family:

- team total: 62/80 = 77.5%
- game total: 23/39 = 59.0%
- moneyline: 37/64 = 57.8%
- handicap: 42/80 = 52.5%

The important product conclusion was not to encode these sample percentages as future probabilities. Instead:

- independent evidence became a first-class ranking signal;
- standalone league ranks were demoted to context;
- exact team-total confluence is prioritized when independently supported;
- raw editorial score remains separate from evidence tier.

## Validation completed

Deterministic tests cover:

- GAME total generation
- team-total attack + opponent-defense confluence
- handicap cover math
- 5/10/20 sample preference
- Wilson lower bound usage
- league top/bottom ranking
- defense-direction mapping
- advanced attack-vs-defense mapping
- venue exact splits
- H2H team-total direction
- H2H handicap direction
- exact-market consolidation
- direct-primary preference over contextual rank
- A/B/C evidence tier assignment
- broad-line editorial penalty
- GAME vs REG portfolio separation
- REG exact provider matching
- wrong-period rejection
- stale/closed provider rejection
- empty-provider-feed fail-closed behavior
- DEMO fallback
- Broadcast evidence badge source

The complete Worker import graph passed repeated `wrangler deploy --dry-run` checks after the Stage 2 changes.

## Next work

1. deploy the current bundled Stage 2 update;
2. rerun production smoke/backtest on the new portfolio behavior;
3. inspect advanced-context coverage on a broader regular-season sample;
4. connect real Winline provider payloads when available;
5. begin player/goalie game feature layer and player-vs-opponent splits;
6. build HOH-owned xG from official NHL shot coordinates later.
