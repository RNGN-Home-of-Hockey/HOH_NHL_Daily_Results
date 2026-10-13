# EPL Data Core

## Goal

Build a football (English Premier League) data core and a Winline-aware insight engine, so broadcast plates can show non-obvious, defensible facts that map to a market Winline really offers. Same product principle as the NHL and NBA parts:

`EPL data -> deterministic signal -> evidence/sample -> Winline market + current odds -> editorial score -> manual SHOW`

Odds are never invented; a statistic is never presented as a guaranteed edge; every number keeps its sample.

## Branch and safety rules

Work lives on branch `feature/epl-football` (created from `main`). It must not change NHL behaviour:

- never push to `main`, never merge without the owner's explicit order (push to `main` deploys the Worker);
- do not edit files that GitHub workflows watch (any `.github/workflows/*`, `cloudflare-worker/src/*`, `tools/build_center_*`, `tools/build_hoh_youtube_media.py`, `ru_full_names.json`): seven workflows have a `push` trigger with only a `paths` filter, so touching those paths on this branch would run them;
- new football code goes into new files (`tools/epl_*`, `tests/test_epl_*`, `docs/EPL_*`, later `epl-worker/`, `wrangler.epl.jsonc`, `migrations/*epl*`), like the NBA part (`nba-worker/`, `wrangler.nba.jsonc`).

Downloaded data is NOT committed (the repository is public and the sources are third-party feeds): it lives in `local-data/` (git-ignored) and, for production, in D1 / the owner's server.

## Collector (`tools/epl_collect.py`)

Standard-library Python, one request at a time with a pause, resumable, raw payloads kept with sha256 in `local-data/epl/raw/manifest.jsonl`.

```
python -I tools/epl_collect.py {matches,details,squads,ranked,fpl,names,build,all} [--refresh]
python -I tests/test_epl_collect.py
```

Output (`local-data/epl/normalized/`): `teams.json`, `players.json`, `matches.json`, `match_details.json`, `h2h.json`, `people.json`, `report.json`.

## Sources and verified coverage (probed 2026-10-12/13)

| Source | Gives | Coverage | Notes |
|---|---|---|---|
| Premier League stats API (`footballapi.pulselive.com`, header `Origin: https://www.premierleague.com`) | matches, goals with scorer/assist/minute, lineups, cards, substitutions, referee; player career and per-season stats; ranked all-time lists; per-match team stats (`/stats/match/{id}`) | matches and goals 1992/93+ (13,225 matches, goal list equals score in 100%); detail pages (events, lineups) for all matches between 2026/27 clubs, back to the 1990s; formation labels mostly 2010s+ | unofficial, no key; no xG |
| Player stats per season (`/stats/player/{id}?comps=1&compSeasons=`) | ~140-190 Opta stats per player-season | 2009/10+ full set (shots, passes, tackles, duels; penalty-area and final-third entries); big chances 2010/11+; touches in opposition box 2011/12+; carries, progressive carries, shot-creating stats 2024/25+ (checked on two veterans, Henderson and Welbeck) | |
| Team stats per match (`/stats/match/{id}`) | ~110-175 stats per team per match: shots, on target, possession, passes, corners, fouls | 1992/93-2005/06 nothing; 2006/07+ shots, on target, possession, passes, corners; 2016/17+ shots inside/outside the box and touches in the opposition box; 2025/26+ PPDA; 2026/27 carries (one mid-season match sampled per season) | `big_chance_*` keys appear intermittently, probably only when non-zero: do not read absence as "not tracked" |
| Fantasy Premier League API | season stats, xG/xA, gameweek history, past seasons, injuries, penalty/corner takers | xG/xA from 2022/23; ICT index from 2016/17; defensive contribution from 2024/25 | FPL assists differ from official (FPL counts more); use PL numbers for assists |
| Understat (`/getLeagueData/EPL/{year}`) | team xG, xGA, npxG, PPDA, deep completions, xPTS per match; player xG/xA/xGChain/xGBuildup/key passes | 2014/15+ (380 matches per season) | third party, terms not reviewed: owner decision before bulk use |
| Sports.ru club squad pages (`/football/club/<slug>/team/`) | Russian names, birth date, nationality, height (JSON-LD) | 576 players on the 20 squad pages; 565 of 598 PL squad players matched (club + birth date) | answered 502/504 on 2026-10-12, fine on 2026-10-13: retry, never work around |
| Wikidata | Russian labels (CC0) | fallback only | spelling differs from Sports.ru |
| Transfermarkt | market values, transfers | not collected | anti-bot challenge (HTTP 202, empty body) and terms reportedly forbid automated access |
| football-data.org, FBref, Sofascore | | not used | key needed / lost Opta advanced stats in 2026 / bot challenge |

## Data rules learned the hard way

- In match events goals are types `G` (goal), `P` (penalty) and `O` (own goal); `teamId` is the side the goal counts for, also for own goals. Filtering only `G` silently drops penalties and own goals; the check "goal list == final score" catches it.
- The PL API sometimes answers HTTP 200 with an empty body for a page that exists: ask once more before treating it as missing.
- Never run two collector processes at the same time (they collide on `.part` files).
- PL ids: the person `id` (e.g. 65970) is the key for goals and stats; `playerId` is another number. FPL joins through the opta code.
- FPL status `u` means the player left the club; about 100 FPL rows are such players.
- Hockey lesson that applies here: say which competition and which time basis a number uses (league only vs all competitions, own goals do not count for the scorer, stoppage time counts).

## Winline: what is available for football (observed 2026-10-13)

Two ways in:

1. Public XML feeds `https://back.winline.ru/banners/{prematch,live,prematch_mainsports,live_mainsports}` (the NHL part already uses them). For football they carry only 21 banner-level market labels: 1X2, double chance, match and half totals, handicaps, both teams to score, which team scores, correct score, corners 1X2. About 21-31 lines per EPL match. No player markets and no cards markets; the labels do not tell team totals from match totals apart, so use the site store for those.
2. The site's own data store, as in `tools/sync_winline_nba.js`: open `https://winline.ru/plus/<event_id>` in a browser and read `window.apiWlb.getEvents().byId(<id>).linesByIdTipMarkets` (market type id -> lines with `koef` = line value, `V` = odds, `tipLine.freeTextR` = market name). EPL match pages carry 92-132 market types.

Market type ids seen on EPL / Champions League / Championship pages (`@NP@` is the "full time" placeholder, `@1HT@`/`@2HT@` halves, `@1`/`@2` home/away team, `[a]` the line):

| Family | Ids |
|---|---|
| 1X2, double chance | 490 (full time), 2 / 956 (halves), 114 / 115 / 966 |
| Both teams to score, combos | 58, 1104, 957, 64 / 65 / 67, 665, 1040 |
| Match total, halves, team totals | 1049, 985 / 960, 1050 / 1051 (home / away) |
| Handicap, European handicap | 1073, 988 / 958, 1080, 967 / 1011 |
| Goals buckets, exact goals, correct score | 56 / 57 / 79, 163, 684 / 687 / 688, 183 |
| Which team scores, first / next / last goal | 166, 1102, 226, 1103 |
| Clean sheet, win to nil, win both / one half | 772 / 820, 238 / 239, 200-203 |
| Corners (1X2, count, total, handicap) | 80, 86 / 90 / 91, 1070-1072, 1079 |
| Cards, sending off | 99, 103 / 104, 661, 1060, 1041, 188 / 675 / 677 |
| Player to score first / any time / last | 15, 197, 198 |

Player lines: only three market types were seen (first scorer, to score, last scorer; 38 players each, "Выйдет и забьет" = comes on and scores, so substitutes count) and only on the featured match Nottingham Forest - Arsenal (2026-10-18). Not present on Everton - Chelsea, Champions League Arsenal - Lille and Championship Wolves - Bolton. Treat player lines as an optional layer, selected matches only.

Not yet verified: how these lines move in play for an EPL match and which player lines appear on match day. Capture test planned for the live EPL matches of 2026-10-17/18 (store timestamped snapshots, compare feed and site store).

## Insight rule families (football analogy of the NHL engine)

Each candidate = fact + sample + the exact Winline line it maps to + current odds; weak or noisy markets get no card.

- Head-to-head: run of wins / unbeaten run between the two clubs, share of wins in the last 10 meetings, home/away split of the meeting, average total goals of the meetings. Market: 1X2, double chance, handicap, total. Example from the data: Arsenal unbeaten in the last 6 meetings with Nottingham Forest, Forest 5.80 to win.
- Chance creation against this opponent (needs team stats per match): shots, shots in the box, touches in the opposition box, big chances, xG where available, compared with the club's average against everyone else. Market: team total, match total, both teams to score.
- Team form: last 5/10 results, goals for/against, clean sheets, scoring in both halves, home/away form, rest days.
- Disciplined/aggressive matchups: cards and corners per match for both clubs and the referee (referee is in the match detail). Market: cards total, corners total.
- Players (when Winline offers them): goals in last N, shots and xG per 90, penalty taker flag (FPL), minutes expectation, record against this opponent. Market: player to score.
- Live (later): shot/xG pressure over the last 10-15 minutes, score state, red card. Market: next goal, team total, next corner.

Ranking is editorial relevance, not probability; no combos from one statistic used twice; odd/even markets get no cards (same policy as NHL).

## Plan

1. Done: collector, dataset, Russian names, tests, this document.
2. Winline football collector: browser-based like the NBA script (Playwright store reader) plus the XML feed; timestamped snapshots so odds history and in-play movement are kept; run in GitHub Actions or on the owner's server. Football tables in D1 under an `epl_` prefix, migration number taken from the current highest at that time.
3. Football data core in D1 (teams, players, matches, events, lineups, team stats per match, Russian names) and a daily/live sync.
4. Insight engine: rule families above, evaluators on the exact Winline line, AIR SCORE style editorial score.
5. Plates: Winline plate designs come from the owner; renderer template and `/broadcast` football room.

## Open decisions

- Understat xG (third-party terms) vs own chance-quality proxy from PL shot/box stats.
- Where Winline snapshots run (GitHub Actions like NBA, or the owner's server) and how long they are kept.
- Licensed data provider before commercial use: all free sources above are unofficial and undocumented.
