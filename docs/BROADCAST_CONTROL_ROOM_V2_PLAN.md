# HOH Live Center — Control Room v2 plan

Goal: make the broadcast dashboard safe for many parallel NHL games/operators and rank cards by editorial value, not only statistical strength.

## P0 — multi-match safety
- [x] Scope `shown` and `preview` status transitions to `game_pk`.
- [x] Allow `/api/broadcast/state?game=<game_pk>`.
- [x] Give every game its own overlay URL: `/broadcast/overlay?game=<game_pk>`.
- [x] Add DB constraints: max one shown card and one preview card per game.
- [ ] Production smoke: two games can be ON AIR at the same time without replacing each other.

## P1 — operator presence and locks
- [ ] Add operator identity stored in the browser.
- [ ] Add a short renewable match lock/lease (target: 90 s) so two people cannot accidentally run the same match.
- [ ] Show operator/lock state in the left match list.
- [ ] Allow explicit takeover after expiry; never permanently lock a match.

## P2 — AIR SCORE
- [ ] Keep statistical/evidence score separate from editorial usefulness.
- [ ] Calculate `air_score 0..100` from clarity, strength, sample relevance, price utility, freshness and market usefulness.
- [ ] Penalize very low-value/safe prices and weak/ambiguous combined stories.
- [ ] Explain the score with 2–3 short reason tags.
- [ ] Sort the default queue by `air_score`, with live urgency handled separately.
- [ ] Never label AIR SCORE as probability or win chance.

## P3 — readable samples and copy
- [ ] <=30 games: use natural counts, e.g. “14 из 20”.
- [ ] 31–99 games: lead with percentage, show exact sample secondarily, e.g. “74% · 80 игр”.
- [ ] >=100 games: lead with percentage and rounded scale, e.g. “68% · 200+ игр”; exact count stays in details.
- [ ] Rewrite handicap facts into plain Russian when that is clearer (e.g. “не проигрывал в 2+ шайбы”).
- [ ] Combine two venue samples into one primary story and keep split detail secondary.

## P4 — card hierarchy/UI
- [ ] Put AIR SCORE and reason tags at the top of the card.
- [ ] Separate “best for air” (top 3) from the rest.
- [ ] De-emphasize cards with no exact Winline line or weak editorial utility.
- [ ] Make headline, market, odds and action scannable in 2–3 seconds.
- [ ] Add compact details drawer for exact sample/evidence.

## P5 — supervisor view
- [ ] Left rail: ON AIR / operator / strong-card count / no-strong-lines state per game.
- [ ] Global view of all active rooms without mixing their overlays.
- [ ] Recent action log: who showed/removed what and when.

## P6 — validation
- [ ] Automated concurrency tests for 15 different games.
- [ ] Same-game collision/lock tests.
- [ ] D1 write/read load smoke.
- [ ] Overlay isolation smoke.
- [ ] AIR SCORE fixtures for obvious good/bad examples.
- [ ] Copy/sample-format fixtures for 20, 80, 200+ game samples.
