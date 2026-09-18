DELETE FROM historical_odds_game_features
WHERE source='the_odds_api_eu_consensus' AND market_key='regular_time_1x2';

INSERT INTO historical_odds_game_features (
  game_pk,source,market_key,home_tri,away_tri,season_id,game_type,regulation_result,
  home_odds,draw_odds,away_odds,favorite_result,favorite_odds,favorite_won,
  home_underdog,away_underdog,home_underdog_win,away_underdog_win,
  high_price_home_win,high_price_away_win,
  realized_return_home,realized_return_draw,realized_return_away,closing_overround_pct
)
SELECT
  o.game_pk,o.source,o.market_key,g.home_tri,g.away_tri,g.season_id,g.game_type,
  CASE hf.regulation_result WHEN 'W' THEN '1' WHEN 'L' THEN '2' ELSE 'X' END AS regulation_result,
  o.home_odds,o.draw_odds,o.away_odds,
  CASE
    WHEN o.home_odds IS NULL OR o.away_odds IS NULL THEN NULL
    WHEN o.home_odds <= o.away_odds THEN '1' ELSE '2'
  END AS favorite_result,
  CASE
    WHEN o.home_odds IS NULL OR o.away_odds IS NULL THEN NULL
    WHEN o.home_odds <= o.away_odds THEN o.home_odds ELSE o.away_odds
  END AS favorite_odds,
  CASE
    WHEN o.home_odds IS NULL OR o.away_odds IS NULL THEN NULL
    WHEN o.home_odds <= o.away_odds
      THEN CASE WHEN hf.regulation_result='W' THEN 1 ELSE 0 END
    ELSE CASE WHEN hf.regulation_result='L' THEN 1 ELSE 0 END
  END AS favorite_won,
  CASE WHEN o.home_odds > o.away_odds THEN 1 ELSE 0 END AS home_underdog,
  CASE WHEN o.away_odds > o.home_odds THEN 1 ELSE 0 END AS away_underdog,
  CASE WHEN o.home_odds > o.away_odds AND hf.regulation_result='W' THEN 1 ELSE 0 END,
  CASE WHEN o.away_odds > o.home_odds AND hf.regulation_result='L' THEN 1 ELSE 0 END,
  CASE WHEN o.home_odds >= 3.0 AND hf.regulation_result='W' THEN 1 ELSE 0 END,
  CASE WHEN o.away_odds >= 3.0 AND hf.regulation_result='L' THEN 1 ELSE 0 END,
  CASE WHEN hf.regulation_result='W' THEN o.home_odds-1.0 ELSE -1.0 END,
  CASE WHEN hf.regulation_result='T' THEN o.draw_odds-1.0 ELSE -1.0 END,
  CASE WHEN hf.regulation_result='L' THEN o.away_odds-1.0 ELSE -1.0 END,
  o.overround_pct
FROM historical_odds_closing o
JOIN games g ON g.game_pk=o.game_pk
JOIN team_game_features hf ON hf.game_pk=g.game_pk AND hf.team_tri=g.home_tri
WHERE o.source='the_odds_api_eu_consensus'
  AND o.market_key='regular_time_1x2'
  AND o.home_odds IS NOT NULL AND o.draw_odds IS NOT NULL AND o.away_odds IS NOT NULL;

DELETE FROM historical_odds_team_trends
WHERE source='the_odds_api_eu_consensus' AND market_key='regular_time_1x2';

WITH scopes AS (
  SELECT *, '2Y' AS scope_key FROM historical_odds_game_features
  WHERE source='the_odds_api_eu_consensus' AND market_key='regular_time_1x2'
  UNION ALL
  SELECT *, 'S_'||season_id AS scope_key FROM historical_odds_game_features
  WHERE source='the_odds_api_eu_consensus' AND market_key='regular_time_1x2'
),
team_rows AS (
  SELECT
    home_tri AS team_tri,source,market_key,scope_key,
    1 AS is_home,home_odds AS team_odds,
    home_underdog AS underdog,home_underdog_win AS underdog_win,
    high_price_home_win AS high_price_win,realized_return_home AS realized_return
  FROM scopes
  UNION ALL
  SELECT
    away_tri,source,market_key,scope_key,
    0,away_odds,
    away_underdog,away_underdog_win,
    high_price_away_win,realized_return_away
  FROM scopes
)
INSERT INTO historical_odds_team_trends (
  team_tri,source,market_key,scope_key,games,avg_home_odds,avg_away_odds,
  home_underdog_games,home_underdog_wins,away_underdog_games,away_underdog_wins,
  away_high_price_wins,flat_home_roi_pct,flat_away_roi_pct
)
SELECT
  team_tri,source,market_key,scope_key,COUNT(*) AS games,
  AVG(CASE WHEN is_home=1 THEN team_odds END),
  AVG(CASE WHEN is_home=0 THEN team_odds END),
  SUM(CASE WHEN is_home=1 THEN underdog ELSE 0 END),
  SUM(CASE WHEN is_home=1 THEN underdog_win ELSE 0 END),
  SUM(CASE WHEN is_home=0 THEN underdog ELSE 0 END),
  SUM(CASE WHEN is_home=0 THEN underdog_win ELSE 0 END),
  SUM(CASE WHEN is_home=0 THEN high_price_win ELSE 0 END),
  100.0 * SUM(CASE WHEN is_home=1 THEN realized_return ELSE 0 END)
    / NULLIF(SUM(CASE WHEN is_home=1 THEN 1 ELSE 0 END),0),
  100.0 * SUM(CASE WHEN is_home=0 THEN realized_return ELSE 0 END)
    / NULLIF(SUM(CASE WHEN is_home=0 THEN 1 ELSE 0 END),0)
FROM team_rows
GROUP BY team_tri,source,market_key,scope_key;

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('historical_odds.features_materialized','1',CURRENT_TIMESTAMP),
  ('historical_odds.high_price_threshold','3.0',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
