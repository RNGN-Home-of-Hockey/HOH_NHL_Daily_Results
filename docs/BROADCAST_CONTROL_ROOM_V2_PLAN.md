# HOH Live Center — Control Room v2 plan

Goal: make the broadcast dashboard safe for many parallel NHL games/operators and rank cards by editorial value, not only statistical strength.

## P0 — multi-match safety
- [x] Scope `shown` and `preview` status transitions to `game_pk`.
- [x] Allow `/api/broadcast/state?game=<game_pk>`.
- [x] Give every game its own overlay URL: `/broadcast/overlay?game=<game_pk>`.
- [x] Add DB constraints: max one shown card and one preview card per game.
- [x] Production smoke creates two isolated ON AIR rooms in remote D1, verifies both through the deployed Worker, then cleans them up.

## P1 — operator presence and locks
- [x] Add operator identity stored in the browser.
- [x] Add a 90-second renewable match lease; heartbeat every 30 seconds.
- [x] Show operator/lock state in the left match list.
- [x] Let a new operator acquire the room automatically after the previous lease expires.

## P2 — AIR SCORE
- [x] Keep statistical/evidence score separate from editorial usefulness.
- [x] Calculate `air_score 0..100` from evidence strength, sample relevance, price utility, market clarity and presentation complexity.
- [x] Penalize very low-value/safe prices, missing exact lines and weak price-vs-history stories.
- [x] Explain the score with up to three short reason tags.
- [x] Sort the default queue by AIR SCORE, while live cards retain urgency priority.
- [x] Explicitly mark AIR SCORE as editorial broadcast utility, never win probability.

## P3 — readable samples and copy
- [x] <=30 games: keep natural counts, e.g. “14 из 20”.
- [x] 31–99 games: lead with percentage and show exact sample, e.g. “74% · 80 игр”.
- [x] >=100 games: lead with percentage and rounded scale, e.g. “68% · 200+ игр”; exact count stays in details.
- [x] Rewrite handicap facts into plain Russian: positive handicap → “без поражения в N+ шайбы”, negative handicap → “победа в N+ шайбы”.
- [x] Combine two venue samples into one primary percentage story and keep team splits secondary.

## P4 — card hierarchy/UI
- [x] Put AIR SCORE and reason tags at the top of the card.
- [x] Separate “ТОП ДЛЯ ЭФИРА” (up to 3 real Winline lines, AIR SCORE >=55) from the rest.
- [x] De-emphasize cards with no exact Winline line or weak editorial utility.
- [x] Keep headline, market, odds and action visually scannable.
- [x] Add “ДЕТАЛИ” drawer with exact sample, historical rate, price-implied rate, statistical score and explanation.

## P5 — supervisor view
- [x] Left rail shows ON AIR + active operator + cached strong-line count / “НЕТ СИЛЬНЫХ ЛИНИЙ” per game; missing summaries warm lazily with a D1 cache.
- [x] Left match rail acts as the global room view: ON AIR and active operator are visible without mixing overlays.
- [x] Recent global action log: operator, match, show/remove action, card and timestamp.

## P6 — validation
- [x] Automated concurrency test keeps 15 different games ON AIR simultaneously.
- [x] Same-game collision/lease test, including takeover after expiry.
- [x] Remote D1 write/read smoke runs after every Worker deploy and cleans up its probe row.
- [x] Per-game state/overlay isolation smoke.
- [x] AIR SCORE fixtures for obvious good/bad examples.
- [x] Copy/sample-format fixtures for 20, 80 and 200+ game samples.
- [x] AIR SCORE + lease schema fixtures are part of mandatory product CI.


## P7 — live reliability and useful in-game cards
- [x] Repaint the visible score and live metrics from direct NHL play-by-play every 15 seconds; never leave the hero score on the initial D1 snapshot.
- [x] Persist selected-game live score/state back to D1 and run a minute-level NHL scoreboard sync for the global match list.
- [x] Add live SOG, hits, PIM and faceoff metrics from NHL play-by-play.
- [x] Reject weak “5:1 shots therefore match winner” logic; moneyline pressure needs a larger sample, >=70% shot share and no >1-goal deficit.
- [x] Use real offered Winline moneyline/next-goal/period-result markets as conservative fallback cards when a strong live context exists, so exact synthetic-line matching does not empty the queue.
- [x] Make live copy concrete: score, exact shot split and time window are visible in the headline/subtitle.
- [x] Add cache-busting and an automatic watchdog to the OBS overlay so a stuck Browser Source recovers without manual reload.
- [x] Cover score repaint, live metrics, weak-signal rejection, provider-driven fallback and overlay watchdog with product CI.


## P8 — live diversity: periods and pregame context over shot volume
- [x] Shot pressure can no longer create moneyline or total advice by itself.
- [x] Keep at most one shot-led featured card; shots are a secondary next-goal signal only.
- [x] Re-evaluate exact live Winline period-result markets against each team's historical result in that same period.
- [x] Re-evaluate exact live period totals from both teams' historical P1/P2/P3 goal distributions.
- [x] Add live team totals from team scoring + opponent conceding history, with current score/time sanity checks.
- [x] Add live game totals from both teams' recent goal distributions, filtered by the current score and late-game feasibility.
- [x] Add moneyline only when pregame form + opponent form + current score agree; shots are excluded from this decision.
- [x] Reprice saved pregame signals against the current live Winline line when the market is still logically relevant.
- [x] Diversify the top four live cards by origin and label period / pregame / totals / shot-support angles explicitly in the UI.
- [x] Cover the no-shot-moneyline invariant and period/pregame live mix with mandatory product CI.
