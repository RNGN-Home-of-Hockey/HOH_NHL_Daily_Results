# NBA Data Core

## Goal

Build an NBA statistical warehouse inside the existing HOH data platform so the broadcast product can generate defensible player/team stories and later attach real Winline markets and odds to those stories.

The first milestone is historical coverage: every available player game log and team game log for the last five completed NBA seasons.

## Architecture

The NBA path follows the same separation already used by the NHL broadcast product:

`NBA official stats -> NBA adapter/backfill -> D1 -> Stats/Insight Engine -> NBA Broadcast Center`

Winline remains a provider layer attached after a statistical signal or matchup has been selected:

`Insight / Match -> Suggested market -> Winline Provider -> odds + deeplink`

Bookmaker data is never the source of statistical truth.

## Historical scope

Initial backfill:

- 2021-22 Regular Season + Playoffs
- 2022-23 Regular Season + Playoffs
- 2023-24 Regular Season + Playoffs
- 2024-25 Regular Season + Playoffs
- 2025-26 Regular Season + Playoffs

This gives five complete seasons for 2/3/5-year calculations without mixing incomplete 2026-27 data into historical baselines.

The current season will be added as an incremental sync layer in the next phase.

## Source

The importer uses the NBA Stats league-wide bulk endpoints:

- `playergamelogs` — all player-game rows for a season/type
- `teamgamelogs` — all team-game rows for a season/type

That means the backfill does not make one request per player. For five seasons and two season types, the baseline import is twenty source requests total: ten team payloads and ten player payloads.

## Reliability rules

`stats.nba.com` can be sensitive to request frequency and server/cloud traffic. The importer therefore:

- uses current browser-like request headers;
- sends requests sequentially;
- sleeps between source calls;
- retries failures with exponential backoff and jitter;
- stores the exact raw JSON payload for audit/debugging;
- hashes each raw player/team payload into `nba_sync_manifest`;
- generates deterministic SQL and never makes the production portal depend on a live NBA Stats request.

## D1 tables

Migration `0044_nba_data_core.sql` creates an NBA-specific namespace and does not modify NHL facts.

### `nba_teams`

One row per NBA team identity observed in the bulk logs.

Important fields:

- `team_id`
- `abbreviation`
- `team_name`
- `last_seen_game_date`
- `last_seen_game_id`

### `nba_players`

One row per NBA player observed in player game logs.

Important fields:

- `player_id`
- `full_name`
- `current_team_id`
- `current_team_abbr`
- `last_seen_game_date`
- `last_seen_game_id`

The dimension update is date-aware: importing an older season after a newer one cannot regress the player's current team.

### `nba_games`

One row per game reconstructed from the two team-game rows.

Important fields:

- `game_id`
- `season_year`
- `season_type`
- `game_date`
- home/away team IDs and abbreviations
- home/away scores

### `nba_team_game_stats`

One row per team per game. Initial base fields include:

- points
- field goals / attempts / percentage
- 3PT made / attempts / percentage
- free throws made / attempts / percentage
- offensive / defensive / total rebounds
- assists
- turnovers
- steals
- blocks / blocks against
- personal fouls / fouls drawn
- plus/minus
- minutes
- W/L and matchup

Primary key: `(game_id, team_id)`.

### `nba_player_game_stats`

One row per player per game with the same core box-score family plus:

- player/team identity
- points
- rebounds
- assists
- steals
- blocks
- turnovers
- 3PT makes/attempts
- FT/FG splits
- plus/minus
- NBA fantasy points
- double-double / triple-double flags

Primary key: `(game_id, player_id)`.

Indexes are included for chronological player/team queries and common future player markets: points, rebounds, assists and made threes.

### `nba_sync_manifest`

One row per `(season_year, season_type)` recording:

- player row count
- team row count
- game count
- first/last game dates
- SHA-256 of both official NBA payloads
- fetch timestamp

This is the first-line completeness/audit table.

## Idempotency

All fact tables use natural NBA IDs and `ON CONFLICT ... DO UPDATE`.

Re-running the same five-season backfill updates the same rows rather than creating duplicates.

The generated SQL is split into bounded chunks so a full season of player-game rows is not sent to D1 as one oversized SQLite statement.

## Workflow

`.github/workflows/backfill-nba-five-seasons.yml`:

1. applies D1 migrations to `hoh-data-core`;
2. downloads all ten season/type pairs for both bulk endpoints;
3. generates chunked SQL plus raw snapshots;
4. imports SQL into D1;
5. prints coverage grouped by season/type;
6. verifies player/team facts have no missing game/dimension rows;
7. uploads raw NBA responses and `summary.json` as a 30-day workflow artifact.

## Next phase

After the historical base is loaded and verified:

1. add 2026-27 schedule/current-season incremental sync;
2. add advanced/team/player NBA endpoints where they materially improve broadcast markets;
3. compute rolling samples (`L3`, `L5`, `L10`, season, 2y, 3y, 5y);
4. compute opponent and home/away splits;
5. create NBA insight/evidence tables;
6. map signals to NBA Winline markets (points, rebounds, assists, threes, team totals, game totals, spreads, moneyline and combinations actually present in the feed);
7. build an NBA-specific broadcast control room without changing NHL `/broadcast` behavior.
