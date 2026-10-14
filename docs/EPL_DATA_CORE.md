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
| Understat (`/getLeagueData/EPL/{year}`) | team xG, xGA, npxG, PPDA, deep completions, xPTS per match; player xG/xA/xGChain/xGBuildup/key passes | 2014/15+ (380 matches per season) | NOT collected: its robots.txt is `User-agent: * / Disallow: /` (checked 2026-10-13). Three one-request format probes were made before that was known; nothing is stored. xG proxy from PL shots in the box etc. instead |
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

Player lines: three market types (first scorer 15, to score 197, last scorer 198; 38-48 players each; "Выйдет и забьет" = comes on and scores, so substitutes count). The page loads them lazily: they appear in the store only after the "Игроки" tab is opened (and the quick-markets group after "Быстрые"), so a capture must click every tab. Correction of an earlier note: the first probes did not open that tab and wrongly concluded that only one match had player lines. Capture of all 20 listed EPL matches on 2026-10-13 09:50 MSK: the 9 matches of 17-18 October had 114-144 player lines each (~240-270 lines in total), the 11 matches of 19 October and later had none and only ~43 lines (the line list grows as kickoff nears).

Not yet verified: how lines move in play for an EPL match and which extra markets appear on match day. Capture test planned for the live EPL matches of 2026-10-17/18 (timestamped snapshots).

## Insight rule families (football analogy of the NHL engine)

Each candidate = fact + sample + the exact Winline line it maps to + current odds; weak or noisy markets get no card.

- Head-to-head: run of wins / unbeaten run between the two clubs, share of wins in the last 10 meetings, home/away split of the meeting, average total goals of the meetings. Market: 1X2, double chance, handicap, total. Example from the data: Arsenal unbeaten in the last 6 meetings with Nottingham Forest, Forest 5.80 to win.
- Chance creation against this opponent (needs team stats per match): shots, shots in the box, touches in the opposition box, big chances, xG where available, compared with the club's average against everyone else. Market: team total, match total, both teams to score.
- Team form: last 5/10 results, goals for/against, clean sheets, scoring in both halves, home/away form, rest days.
- Disciplined/aggressive matchups: cards and corners per match for both clubs and the referee (referee is in the match detail). Market: cards total, corners total.
- Players (when Winline offers them): goals in last N, shots and xG per 90, penalty taker flag (FPL), minutes expectation, record against this opponent. Market: player to score.
- Live (later): shot/xG pressure over the last 10-15 minutes, score state, red card. Market: next goal, team total, next corner.

Ranking is editorial relevance, not probability; no combos from one statistic used twice; odd/even markets get no cards (same policy as NHL).

## Winline capture (`tools/winline_football/`)

`catalogue.mjs` turns the store lines into normalized markets: family, period (FT/1H/2H), scope (match/home/away/player), exact line, outcomes with sides. The template placeholders (`@NP@`, `@1HT@`, `@1`/`@2`, `[a]`) are parsed generically, so the long tail of the ~100 market types per match is classified without listing every id (about 99% of lines get a family). Handicaps: the site stores the absolute size and the favourite flag (`favorite` 1 or 2); the favourite gives the goals. Player lines: `koef` is `"2@ Name/9"` (team index, name, optional number) with one price. `capture.mjs` opens the listing and each event page in the installed Chrome (`playwright-core`, no browser download), clicks every market tab and writes timestamped snapshots to `local-data/epl/winline/snapshots/<time>/` plus `latest.json`. Football is `idSport 1`, the Premier League `idChampionship 1`.

```
cd tools/winline_football && npm install && npm test        # 9 tests
node capture.mjs [--championship 1] [--events id,id] [--limit 30] [--pause 2500]
```

About 12 s per match, one at a time; it stops at once if the site shows a challenge page. Storage on a server (owner will provide one) is the next step: the snapshots are plain JSON files with `captured_at`.

## Team statistics per match (`epl_collect.py teamstats`)

`stats/match/{id}` for every league match since 2016/17 and for matches between 2026/27 clubs since 2006/07 (about 5,000 requests, newest first, resumable) into `normalized/team_match_stats.json` (shots, on target, shots inside/outside the box, box touches, possession, corners, cards, PPDA, big chances, carries... keys the feed does not list for a match are absent).

## Own xG model (`tools/epl_xg.py`)

Owner's decision 2026-10-13: calculate it ourselves (or use aggregators), no contact with Understat. The model prices every kind of shot by the real goals of 7,856 team-matches (2016/17+, the seasons whose feed splits shots by zone; non-negative least squares, no intercept): a big chance 0.39 goals, any other shot inside the box 0.051, a shot from outside 0.036, then a per-season factor so that each season's total xG equals its non-penalty goals (Opta's tagging drifts; the current season borrows the previous factor until it has 300 team-matches). Penalties are not in the model (the data lists penalty goals, not awards): it is a non-penalty xG. A counter the feed does not list is zero; a match with no shot counter is skipped.

Checks: fitted before 2025 and tested on 2025/26+ it correlates 0.46 with real goals per team-match (one price per shot: 0.24; per-match goals are noisy by nature); against the REAL Opta xG that Fantasy publishes per player (summed per team, current season, 118 team-matches) the correlation is 0.85 and the mean error 0.34 goals. `python -I tools/epl_xg.py` refits and writes `normalized/xg_proxy.json` and `xg_model.json`; `epl_site_data.py` merges it as `xg_proxy`, and the chance-creation rule uses it first. 5 tests in `tests/test_epl_xg.py`.

Aggregators looked at (robots.txt and a plain request, 2026-10-13): Sofascore answers a bot challenge and its robots.txt closes seasonal paths: not used, no workaround. Understat: `Disallow: /`. FotMob: pages allowed, `/api/*` disallowed for generic bots. Flashscore: the feed host has no robots.txt, but flashscore.com disallows `/x/`; the owner's tennis project uses that feed. WhoScored, FootyStats, 365Scores: not used. Not scanned, because the own model already tracks real xG at 0.85; Flashscore is the first one to try if a second opinion is ever needed.

## Trend engine v2 and grading (`tools/epl_engine.py`)

Owner 2026-10-14: a full site with the most interesting trends and bets for teams and players on the Winline line, a big choice and a grading of how strong each plate is. The basic rules of `tools/epl_insights.py` stay; `epl_engine.py` adds the club match history (`club_rows`: result, halves and goal order from the detail pages, corners, cards, shots) and these families, each tied to the exact Winline line:

- Result: win share in recent form, home/away form, win to nil, clean sheet, handicap margin (one card per club: the boldest line the record still covers, odds 1.40+).
- Goals: match total, both teams to score, team goal buckets (0 / exactly 1 / 2 / 3+).
- Halves: first-half total, team goal in the first half, which half has more goals, scores in both halves, wins a half / both halves, half-time lead.
- Match flow: scores first, last goal, first goal by minute 10/15.
- Corners and cards (cards are marked beta: referee not yet used).
- Players: model chance vs price (xG Opta per 90 blended with last season or the position's usual level × average minutes of the last five rounds, Poisson; only 20%+ chances and odds up to 8), record against this opponent (4+ meetings in 6 years), first/last goal of the match share.

Every card gets `category` (Исход, Голы, Таймы, Ход матча, Угловые, Карточки, Игроки), `basis` (Личные встречи, Форма, Моменты, Модель), `score` and a tier: Огонь ≥ 80, Сильная ≥ 65, Рабочая ≥ 50, Фон ≥ 35 (stars 5–2). Score = 40% history vs price (Wilson lower bound / implied probability), 20% sample, 15% usable odds, 15% how striking (perfect record, long run, near-perfect, real price), 10% rule weight. Сильная/Огонь need at least four hits, and a sample under 8 only when it is perfect ("4 из 4"). Same fact on several lines = one card with alternatives; at most 3 cards per rule and 45 per match. Boards: `team_profile` (last 8 matches: form, goals, xG, totals, BTTS, clean sheets, halves, scores first, corners, cards) and `player_board_rows` (every Winline player line with odds, model vs price, form, record vs opponent, best card). 10 tests in `tests/test_epl_engine.py`.

`tools/epl_site_data.py` writes `local-data/epl/site/site.json`: matches (quick odds, every market, players, head-to-head, form and stats, cards), `teams`, `tiers`, `categories`, `bases`.

## Operator site v2 (`epl-site/`)

Light theme, four pages: **Лента** (every card of every match; filters by tier, market, basis, match, team, odds range, text; five sort orders), **Матчи** (match list; tabs Карточки / Рынки Winline / Игроки / Личные встречи / Форма и статистика), **Игроки** (all player lines: first/anytime/last odds, model vs price, value, goals/xG, last five, record vs opponent, best card; sortable), **Команды** (profiles of all 20 clubs, sortable; click = the club's cards or its next match). «Эфир» queue on every page (placeholder plate until the Winline designs arrive). The data reloads every 5 minutes. Locally: `python -I tools/epl_serve.py`.

## Hosting and pipeline

- **Cloudflare worker `hoh-epl`** (account rngn f7f0376b, https://hoh-epl.rngn.workers.dev, config `epl-worker/wrangler.jsonc`): serves `epl-site/`, `GET /data/site.json` from KV `hoh-epl-data`, `POST /api/ingest` (Bearer secret `EPL_INGEST_KEY`, gzip body with `x-epl-encoding: gzip`), `GET /api/health`. noindex everywhere. Separate from the NHL workers and hoh-data-core. Deploy: `wrangler deploy --config epl-worker/wrangler.jsonc`.
- **Server `hoh`** (`/opt/hoh-epl`): `repo/` = copy of the EPL tools, `repo/local-data/epl/` = data, `secrets/ingest.key` (0600). `hoh-epl-lines.timer` runs `deploy/epl/run_lines.sh` 10 minutes after the previous run ends: Winline capture (server Chromium binary in a throwaway profile, never the hoh-chromium service) → `epl_site_data.py` → `epl_publish.py`. Every capture is kept gzip-compressed in `winline/snapshots/<time>/` — the database of line movements. Nice 10, idle IO, 4 GB memory cap.
- **Statistics come from the PC**: the Premier League API answers 403 and Fantasy 503 to the server's Russian IP. `tools/epl_refresh_stats.py` (Windows Task Scheduler) runs `epl_collect.py all` + `epl_xg.py`, sends `normalized/` as one archive, and `deploy/epl/receive_stats.sh` swaps it in under the same lock as the line job. If the PC is off, lines keep updating and the statistics wait.
- Update code on the server: copy the changed files into `/opt/hoh-epl/repo` (the server has no GitHub access).

## Plan

1. Done: collector, dataset, Russian names, Winline capture, own xG, engine v2 with tiers, operator site v2, worker on rngn, server pipeline.
2. Next: referee for cards, line movement on cards (snapshot history), live mode (in-play lines), plates when the Winline designs arrive (renderer template, `/broadcast` football room).

## Open decisions

- Licensed data provider before commercial use: all free sources above are unofficial and undocumented.
- Access to the operator site (open link with noindex now; a password can be added in the worker).
