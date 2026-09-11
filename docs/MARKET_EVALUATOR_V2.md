# HOH Market Evaluator V2

Date: 2026-09-11

## Purpose

Stage 2 turns the historical NHL Data Core into market-first broadcast candidates.

The engine no longer relies on a few fixed rules such as only total 5.5 or team total 2.5. It evaluates a grid of common markets and chooses the strongest defensible sample.

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

## Portfolio suppression

The evaluator intentionally suppresses adjacent redundant lines in the final candidate set.

Current limits:

- max 1 game-total candidate
- max 1 team-total candidate per team
- max 1 handicap candidate per team
- rolling league rank engine max 4 cards, max 2 per market subject

The global Betting Insight Engine then combines these with existing H2H, period, feature and live candidates and keeps the top 12 by score.

## Integration

Both V2 modules are called directly from:
`cloudflare-worker/src/betting-insight-engine.js`

Broadcast V2 already uses `buildBettingInsights()`, therefore no separate UI integration is required. A Worker deploy is sufficient for the new cards to appear.

## Tests completed

Validated with deterministic synthetic datasets:

- exact game total candidate generation;
- team-total offense + opponent-defense confluence;
- handicap cover math;
- preference for stable 20-game samples;
- duplicate-line suppression;
- league top-3 / bottom-3 ranking;
- defensive market direction.

## Next Stage 2 work

1. enrich exact market candidates with advanced 5v5 context from `team_game_advanced_features` (xGF%, CF%, FF%, PDO, GSAx);
2. add home/away and H2H market-specific splits;
3. add market-line adapter for real Winline lines so only actually offered lines are evaluated;
4. add player/goalie game features and player-vs-opponent splits later;
5. add own HOH xG from NHL shot coordinates.
