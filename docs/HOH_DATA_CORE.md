# HOH Data Core

## Purpose

HOH Data Core is the shared data layer for two separate products:

1. **Broadcast Stats** — pre-match and live statistical candidates for a human operator to approve and show in the broadcast overlay.
2. **Telegram Live Center** — player/team/game subscriptions, match center pages, live data and notifications.

The existing NHL Single Result Bot remains an independent production system while Data Core is built. Do not switch the old bot to D1 until Data Core import and validation are complete.

## Core rule

**Automation prepares data; a human decides what appears on air.**

Broadcast cards may be generated, ranked and updated automatically, but they are never shown automatically.

## Data flow

NHL API -> NHL Adapter -> D1 -> Stats/Insight Engine -> Broadcast Center / Telegram Live Center

Winline is a separate provider layer attached after an insight or match context has been selected:

Insight / Match -> Suggested market -> Winline Provider -> odds + deeplink

Statistics must never be inferred from bookmaker data.

## Initial historical scope

Backfill target:

- 2024/25 NHL season
- 2025/26 NHL season
- 2026/27 incrementally as games are played

## Source-of-truth principles

- NHL official API is the source of truth for games, scores, states and play-by-play.
- Russian names may be seeded from the existing `ru_map.json` and later maintained in D1.
- Every calculated statistical insight must retain machine-verifiable evidence: numerator, denominator, filters and source game IDs.
- Re-running an importer for the same game must be idempotent and must not create duplicates.

## Phase 1 tables

The first migration creates:

- `teams`
- `players`
- `games`
- `period_scores`
- `game_events`
- `event_players`
- `team_game_stats`
- `player_game_stats`
- `standings_snapshots`
- `sync_runs`
- `insights`
- `broadcast_cards`
- `telegram_users`
- `subscriptions`
- `notification_log`
- `winline_events`
- `winline_markets`

## Build sequence

1. Create D1 database `hoh-data-core`.
2. Add D1 binding `DB` to Wrangler.
3. Apply migration `migrations/0001_hoh_data_core.sql`.
4. Add a read-only Data Core health/schema endpoint.
5. Build NHL importer for teams/games/play-by-play.
6. Backfill two historical seasons.
7. Validate imported games against NHL API samples.
8. Build first deterministic Stats Engine rules.
9. Build Broadcast Center MVP.
10. Build Telegram Mini App / Live Center.
11. Attach Winline provider after partner API approval.

## Safety during migration

Until explicitly changed later:

- existing Telegram result posts continue to use `nhl_single_result_bot.py` and its current state file;
- `CLOUDFLARE_CRON_ENABLED` stays unchanged;
- existing repository dispatch workflow remains unchanged;
- no broadcast card can auto-publish;
- no new D1 data affects production Telegram output.
