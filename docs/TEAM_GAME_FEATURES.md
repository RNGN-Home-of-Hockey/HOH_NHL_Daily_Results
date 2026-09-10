# HOH Team Game Features

## Purpose

`team_game_features` is the materialized analytics layer between raw NHL game data and HOH betting/editorial insights.

Raw play-by-play remains the source of truth. The feature layer stores compact, reusable facts once per team per completed game so Broadcast Stats does not repeatedly scan hundreds of play-by-play rows for every card.

One NHL game produces exactly two feature rows: one for each team.

## Feature groups

### Result / market outcomes

- final goals for / against
- total goals
- final goal difference
- final win
- regulation goals for / against
- regulation result: W / L / T
- overtime / shootout flags

These support:

- regulation 1X2
- moneyline
- handicap hit rates
- full-game totals
- team totals
- result + total combinations

### Period features

- P1 / P2 / P3 goals for and against
- score differential after P1
- score differential after P2
- P1 / P2 / P3 shots on goal

These support:

- period 1X2
- period totals
- strongest/weakest-period rankings
- period-specific live context

### First-goal feature

- whether the team scored the first non-shootout goal

Supports:

- first team to score
- lead-protection / comeback studies later

### Possession / territorial features

- shots for / against / shot share
- Corsi for / against / CF%
- Fenwick for / against / FF%

HOH calculation from NHL play-by-play:

- Fenwick = goals + shots on goal + missed shots
- Corsi = Fenwick + blocked shot attempts
- NHL play-by-play attributes a `blocked-shot` event to the blocking team, so the attacking team for that attempt is the opponent. The materializer explicitly reverses ownership for blocked-shot Corsi accounting.

These are intended to create context usually absent from standard broadcast graphics.

### Physical / special teams context

- power-play goals for / against
- hits for / against
- PIM for / against

More complete PP/PK opportunity and rate features will be added after the importer carries the required denominator data reliably.

### Schedule context

- previous game timestamp
- rest days
- back-to-back flag

Supports:

- team performance without rest
- rest advantage/disadvantage
- future travel/schedule-context rules

## Materialization

Migration `0004_team_game_features.sql`:

1. creates the table and indexes;
2. seeds features for every existing regular-season/playoff game in Data Core.

`refreshTeamGameFeatures()` in `cloudflare-worker/src/team-game-features.js` recomputes the two feature rows for a newly imported game.

Historical backfill calls this immediately after each successful game import.

## Insight rules currently backed by the feature layer

`cloudflare-worker/src/feature-market-insights.js` currently evaluates:

- team total O/U 2.5 hit rate
- opponent + team total 2.5 confluence
- full-game O/U 5.5 hit rate
- handicap -1.5 cover rate
- first team to score
- P1 result trend
- P2 result trend
- home/away win split
- Corsi + Fenwick control
- back-to-back performance
- league second-period ranking

All thresholds are editorial filters, not model probabilities.

## Next feature versions

Planned additions:

- exact selectable game-total lines: 4.5 / 5.5 / 6.5 / 7.5
- exact selectable team-total lines: 1.5 / 2.5 / 3.5 / 4.5
- handicap distributions: +/-1.5 / +/-2.5
- regulation-only margin outcomes
- score-state splits
- PP/PK opportunities and efficiency
- empty-net separation
- goalie-start context
- player rolling shot/point features
- own HOH xG model from NHL coordinates and shot context
- high-danger attempts
- goals saved vs HOH xG

## Product rule

The engine should be market-aware:

`available/simulated Winline market -> matching features -> sample/evidence -> editorial score -> operator candidate`

It should not surface a generic stat simply because it is available.
