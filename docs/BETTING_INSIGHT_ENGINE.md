# HOH Betting Insight Engine

## Product goal

The engine must not duplicate ordinary NHL broadcast statistics. Its job is to produce short, defensible statistical stories that naturally map to a Winline market.

Pipeline:

`NHL data -> deterministic signal -> evidence/sample -> relevance score -> Winline market mapping -> editor preview -> manual SHOW`

Until the real Winline feed is connected, development/demo mode uses deterministic synthetic odds from 1.30 to 9.00. They are always marked `DEMO` / `odds_is_demo=true`; production odds must later come only from Winline or explicit operator input.

## Card contract

Every candidate must contain:
- exact factual statement;
- timeframe / sample size;
- evidence values and source game IDs where practical;
- signal category;
- 0–100 editorial relevance score (not betting probability);
- suggested Winline market type;
- suggested team/player/side;
- timing: pregame / live / intermission;
- odds from Winline only;
- promo code layer handled separately;
- final display is always manual.

## Rule families

### Tier A — live momentum

1. Last 20 shots on goal share.
   Example: CAR has 15 of the last 20 SOG.
   Markets: next goal team, next team to score.

2. Last 10 / 20 shot attempts share.
   Markets: next goal, live team total.

3. Five-minute shot pressure.
   Compare last five minutes with match baseline.

4. Consecutive offensive-zone pressure proxy.
   Shot attempts + missed shots + blocks without opponent response.

5. Post-power-play pressure.
   Shots / goals in 2–5 minutes after PP starts or ends.

6. Penalty momentum.
   Team penalty frequency and opponent PP conversion context.

7. Score-state pressure.
   How a team performs when trailing by one / leading by one.

8. Late-period scoring tendency.
   Goals in final five minutes of periods.

### Tier A — pregame team form

9. Last 5 / 10 game win rate.
10. Last 5 / 10 goals for and against.
11. Last 5 / 10 average total goals.
12. Home-only recent form.
13. Away-only recent form.
14. Performance after a win/loss.
15. Performance on back-to-back games when schedule data is available.
16. Rest advantage: 0/1/2+ days rest.
17. One-goal game performance.
18. Overtime frequency.

### Tier A — period-specific

19. First-period goal differential rank.
20. Second-period goal differential rank.
21. Third-period goal differential rank.
22. Best/worst league rank by period scoring.
23. Period total trend.
24. Scoring first in a period.
25. Protecting a lead in third period.
26. Comeback scoring when trailing after two periods.

### Tier B — matchup/history

27. Last 3 / 5 / 10 head-to-head winner trend.
28. Head-to-head average total.
29. Head-to-head first-period trend.
30. Home team dominance in this matchup.
31. Matchup shot-share trend.
32. Matchup PP/PK trend.

### Tier B — league context

33. East vs West win rate.
34. Division vs division win rate.
35. Home vs away league win rate.
36. League scoring environment by month.
37. League overtime/share by month.
38. Team percentile vs league in scoring, defense, shots, PP and PK.

### Tier A/B — special teams

39. PP conversion last 10 games.
40. PK success last 10 games.
41. Opponent PP vs team PK mismatch.
42. PP goals per opportunity trend.
43. Penalties drawn / taken trend when derivable.

### Tier B — player/goalie layer

44. Player points streak.
45. Player goals in last N games.
46. Player shots in last N games.
47. Player performance vs opponent.
48. Goalie save percentage last N starts.
49. Goalie goals saved vs baseline proxy when shot quality data becomes available.
50. Team scoring with current goalie opponent context.

## Initial production implementation

Implemented first:
- last 20 shots on goal momentum;
- recent team form;
- recent team total-goal environment;
- second-period league rank;
- head-to-head trend;
- East vs West season trend.

These rules intentionally enforce minimum sample sizes. No card is generated when evidence is too weak.

## Ranking

Candidate score is editorial relevance, not probability.

Suggested order of importance:
1. strong live signal + relevant Winline live market;
2. strong team-specific historical trend;
3. period-specific top/bottom league rank;
4. opponent mismatch / special teams;
5. head-to-head;
6. league-wide context.

Deduplicate cards that communicate the same underlying idea.

## Winline integration

The engine emits a market hint, not fabricated odds.

Example candidate payload:

```json
{
  "title": "CAR нанёс 15 из последних 20 бросков в створ",
  "evidence": {"sample_size": 20, "shots_by_team": {"CAR": 15, "VGK": 5}},
  "market": {
    "type": "next_goal_team",
    "subject": "CAR",
    "label": "Следующий гол — CAR",
    "odds": null,
    "provider": "winline_pending"
  }
}
```

After Winline API access:
- match NHL game to Winline event;
- match `market.type` to provider market;
- attach current odds/deeplink/timestamp;
- expire a candidate when its market disappears or its evidence is no longer current;
- never reuse stale odds.

## Live ingestion requirement

Historical backfill alone cannot support live momentum cards.

Required live loop:
- discover games in LIVE/CRIT state;
- poll official NHL play-by-play frequently;
- update only changed game/event rows;
- run lightweight live rules after each update;
- emit candidate changes to Broadcast Control;
- do not auto-show cards.

Historical rules should be precomputed/cached so live requests do not repeatedly scan whole seasons.
