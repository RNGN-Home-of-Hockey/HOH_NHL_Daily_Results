# HOH × Winline — Market-Aware Insight Matrix

## Product principle

HOH must not repeat ordinary scorebug/broadcast statistics. A candidate should connect a non-obvious, defensible hockey fact to a market that is actually present in Winline.

Pipeline:

`Winline live market -> exact line/period/selection -> NHL/HOH features -> deterministic rules -> evidence -> editorial score -> candidate -> manual SHOW`

Important:
- odds are never invented;
- statistics do not imply a guaranteed betting edge;
- every numerical statement keeps sample/evidence;
- the engine evaluates the actual current line (e.g. O/U 5.5), not a generic 'over' concept;
- weak/noisy markets may intentionally receive no card.

## Winline market families seen in the reference UI

### 1. 1X2 — regulation / period

Useful facts:
- regulation-only W/L/D rate, not final result including OT/SO;
- last 5/10 regulation form;
- season and rolling 5v5 xGF%, SF%, CF%, FF%;
- xG differential /60 and shot differential /60;
- home/away splits;
- rest days and back-to-back;
- opponent-adjusted strength;
- starting-goalie context;
- score-state history for a live period market;
- exact period W/D/L rate and period goal/xG differential.

Strong card examples:
- `CAR controls 57.7% of 5v5 shots on goal — #1 NHL.`
- `CAR has been above 56% xGF over its last 10 games and is #2 NHL for the season.`
- `Team X has won the 2nd period in 9 of its last 13 games.`

Preferred markets:
- regulation winner;
- period winner;
- double chance only when the evidence is specifically about regulation/period non-losses.

### 2. Handicap

Useful facts:
- exact cover rate for the offered line (+1.5, -1.5, +2.5, -2.5);
- percentage of wins by 2+ / 3+ goals;
- percentage of losses by 2+ / 3+ goals;
- average regulation goal differential;
- 5v5 xG differential /60;
- shot differential /60;
- empty-net adjusted score differential where practical;
- opponent's corresponding margin distribution.

Strong card example:
`Team X has won 7 of its last 10; six of those wins were by 2+ goals. Winline line: X -1.5.`

Do not use generic season win percentage alone to justify a handicap.

### 3. Match total — regulation / including OT-SO

The rule must use the exact Winline line.

Useful facts:
- O/U hit rate at exactly 4.5 / 5.5 / 6.5 etc.;
- last 5/10/20 combined goal distribution;
- season combined goal distribution;
- combined xGF+xGA environment;
- 5v5 pace: SF+SA, CF+CA, FF+FA /60;
- high-danger / own-xG shot quality once HOH xG exists;
- PP/PK mismatch and penalties taken/drawn;
- starting goalie recent SV% and goals-against context;
- month/season scoring environment as low-priority context.

Strong card example:
`8 of Team X's last 10 games finished above 5.5; both teams are top-10 in 5v5 shot pace.`

Need separate semantics for regulation-only total vs total including OT/SO.

### 4. Team total

Useful facts:
- exact hit rate for offered team total line;
- team GF distribution: 0/1/2/3/4+;
- xGF/60 and SF/60 recent + season rank;
- opponent xGA/60 and SA/60;
- opponent goalie form;
- PP vs opponent PK;
- scoring by period;
- live shot/xG pressure.

Strong card example:
`CAR is #2 NHL at 3.05 xGF/60 at 5v5 and #2 in shots/60; opponent is bottom-5 in xGA/60. Winline team total: CAR O3.5.`

### 5. Team number of goals — 0–1 / 2 / 3+

This market maps naturally to a discrete scoring distribution.

Useful facts:
- frequency of 0–1, exactly 2, 3+ goals in last 10/20 and season;
- opponent frequency of allowing those buckets;
- home/away split;
- goalie split;
- xGF and shot quality as supporting evidence.

Strong card example:
`Team X scored 3+ in 8 of its last 11; Team Y allowed 3+ in 7 of its last 10.`

### 6. Highest-scoring period

Useful facts:
- share of a team's goals by period;
- exact frequency each period is the team's highest-scoring period;
- league rank in GF/period and xGF/period;
- opponent GA/xGA by period;
- current game-state effect for a live version.

Strong card example:
`42% of Team X's goals this season come in the 2nd period — #1 NHL; Team Y allows its highest xGA/60 in the 2nd.`

### 7. Win every period

Rare-market card. Require large sample and extreme mismatch.

Useful facts:
- frequency of winning all three regulation periods;
- opponent frequency of losing 2+ or all periods;
- period-by-period xG/shot ranks;
- dominance consistency across periods.

Do not surface from a 5-game streak alone.

### 8. Result + total combo

Only generate when two independently strong signals agree.

Examples:
- strong favorite/handicap profile AND strong over environment;
- strong defensive favorite AND under environment.

Do not derive a combo card from one statistic reused twice.

### 9. Odd/even total

Default policy: **do not generate editorial betting cards**.

Reason:
- odd/even streaks are usually pattern noise with no meaningful hockey mechanism;
- historical hit rate alone is not enough to make a useful HOH story.

Only reconsider if a defensible model/mechanism is added later.

## Live signal families

### Shot pressure
- last 10 SOG share;
- last 20 SOG share;
- unanswered SOG streak;
- current-period SOG share;
- SOG in last 5 game minutes;
- total attempts (Corsi) pressure;
- unblocked attempts (Fenwick) pressure.

Suggested markets:
- next goal team;
- team next to score;
- team total;
- period result/total.

### Quality pressure
Once HOH xG exists:
- xG last 5 minutes;
- xG last 10 attempts;
- high-danger chances without opponent answer;
- rebounds / rush chances / slot shots;
- expected-goal share by current period.

This should outrank raw shot-count pressure.

### Special-teams live context
- current PP plus PP shot/xG rate;
- PP conversion recent/season;
- opponent PK quality;
- repeated penalties;
- 5v3 context;
- post-PP pressure.

### Score-state context
- historical win/non-loss rate given current score after P1/P2;
- goal rate when trailing by one;
- opponent lead-protection rate;
- goalie-pull / empty-net state near the end.

## Historical team feature families

Minimum useful store per team/game:
- regulation result and final result;
- goal margin;
- GF/GA by period;
- SOG / attempts / unblocked attempts by period;
- xG/xGA by period once own model exists;
- PP opportunities/goals;
- PK opportunities/goals allowed;
- home/away;
- days rest / back-to-back;
- opponent conference/division;
- score after P1/P2;
- first goal;
- comeback / blown-lead markers;
- goalie starter.

Derived rolling windows:
- last 5/10/20;
- home-only / away-only;
- after 0/1/2+ rest days;
- back-to-back;
- vs East/West/division;
- vs top/middle/bottom opponent strength;
- exact market-line hit distributions.

## Player / goalie layer

Useful for NHL player markets and as supporting team context.

Player:
- SOG last 5/10;
- SOG/60 and attempts/60;
- points/goals streak;
- PP role and PP TOI;
- individual xG/60 once model exists;
- on-ice xGF%, SF%, GF%;
- linemate/unit context;
- opponent matchup.

Goalie:
- last 3/5 starts SV%;
- shots faced /60;
- goals allowed vs xGA once HOH xG exists;
- quality-start proxy;
- rest and consecutive-start context.

## Rule quality gate

A card should score on six axes:
1. market directness — 0–30;
2. statistical extremeness / league percentile — 0–20;
3. sample strength — 0–15;
4. recency — 0–10;
5. agreement of independent indicators — 0–15;
6. editorial novelty — 0–10.

Suggested display threshold: 70/100.

Penalties:
- tiny sample;
- duplicate underlying signal;
- stale market/odds;
- generic fact already visible in NHL broadcast;
- pattern with no hockey mechanism.

Editorial score is not a betting probability.

## Data-source strategy

### Primary production source
Official NHL data should remain the core source for HOH Data Core and live operation.

From official play-by-play HOH can calculate internally:
- SOG share;
- Corsi (all shot attempts);
- Fenwick (unblocked attempts);
- period splits;
- score-state splits;
- rolling form;
- home/away/rest/opponent splits;
- player event rates;
- shot-location features;
- eventually an HOH-owned xG model.

This avoids production dependence on third-party analytics websites.

### External analytics as research/validation
Hockey-Reference and HockeyStats can be valuable for editorial research, validation, and defining which metrics HOH should calculate itself.

Do not build automated scraping/bulk-download ingestion without permission/licensing from the provider.

## Uploaded CSV proof-of-concept observations

The uploaded HockeyStats-style team files show the value of this layer.

For CAR 25-26 at 5v5 in `Team_Analytics`:
- SF% 57.675 — #1 of 32;
- xGF% 55.478 — #2;
- xGF/60 3.05 — #2;
- SF/60 31.14 — #2;
- SA/60 22.85 — best/lowest in the league;
- GF% 53.62 — #8;
- PDO 98.41 — #27.

The uploaded `Team_Game_Logs` has no explicit team column, but its season aggregate aligns with the CAR row. Its latest 10 rows aggregate to approximately:
- xGF% 56.6%;
- SF% 58.8%;
- xGF/60 3.05;
- xGA/60 2.34.

Useful story shape:
`CAR is already #1 NHL in 5v5 shot share and #2 in xGF share; over the latest 10-game window the process remains similarly strong.`

That can support a Winline market context, but the exact line/odds still must come from Winline and the fact itself is not a guarantee of outcome.

The uploaded `On_Ice_Skaters` dataset also supports player/on-ice context such as xGF%, SF%, GF%, oiSh%, oiSv% and PDO. These should be supporting features for player/team market cards rather than standalone betting recommendations.

## Required Winline adapter contract

Every provider market should normalize to something like:

```json
{
  "provider": "winline",
  "event_id": "...",
  "market_id": "...",
  "selection_id": "...",
  "market_type": "team_total",
  "period": "REG",
  "subject": "CAR",
  "side": "over",
  "line": 3.5,
  "odds": 1.90,
  "status": "open",
  "updated_at": "..."
}
```

The Insight Engine should receive the current market first, then calculate facts specifically relevant to that line.

This is stronger than generating generic facts and trying to attach a market afterward.
