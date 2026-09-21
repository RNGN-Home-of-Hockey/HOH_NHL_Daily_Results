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
