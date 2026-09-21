-- Rebuild the 32 x (5/10/20) current team snapshot matrix directly from D1.
-- This mirrors tools/build_compact_snapshots.py closely enough for production
-- ranking while avoiding a dependency on locally generated D1 chunk files.
WITH
windows(window_games) AS (
  VALUES (5),(10),(20)
),
base_ranked AS (
  SELECT
    f.*,
    ROW_NUMBER() OVER (
      PARTITION BY f.team_tri
      ORDER BY f.scheduled_start_utc DESC, f.game_pk DESC
    ) AS rn
  FROM team_game_features f
  WHERE f.game_type IN (2,3)
),
base_summary AS (
  SELECT
    b.team_tri,
    w.window_games,
    MAX(b.scheduled_start_utc) AS as_of_utc,
    COUNT(*) AS sample_size,
    AVG(b.final_goals_for) AS gf_pg,
    AVG(b.final_goals_against) AS ga_pg,
    AVG(b.final_goal_diff) AS goal_diff_pg,
    AVG(b.total_goals) AS total_pg,
    AVG(b.corsi_for_pct) AS corsi_pct,
    AVG(b.fenwick_for_pct) AS fenwick_pct,
    AVG(COALESCE(b.p2_goals_for,0) - COALESCE(b.p2_goals_against,0)) AS p2_diff_pg
  FROM base_ranked b
  JOIN windows w ON b.rn <= w.window_games
  GROUP BY b.team_tri, w.window_games
  HAVING COUNT(*) = w.window_games
),
base_scored AS (
  SELECT
    b.*,
    COUNT(*) OVER (PARTITION BY b.window_games) AS league_teams,
    CASE WHEN b.gf_pg IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.gf_pg IS NULL), b.gf_pg DESC, b.team_tri
    ) END AS rank_gf,
    CASE WHEN b.ga_pg IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.ga_pg IS NULL), b.ga_pg ASC, b.team_tri
    ) END AS rank_ga,
    CASE WHEN b.goal_diff_pg IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.goal_diff_pg IS NULL), b.goal_diff_pg DESC, b.team_tri
    ) END AS rank_goal_diff,
    CASE WHEN b.total_pg IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.total_pg IS NULL), b.total_pg DESC, b.team_tri
    ) END AS rank_total,
    CASE WHEN b.corsi_pct IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.corsi_pct IS NULL), b.corsi_pct DESC, b.team_tri
    ) END AS rank_corsi,
    CASE WHEN b.fenwick_pct IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.fenwick_pct IS NULL), b.fenwick_pct DESC, b.team_tri
    ) END AS rank_fenwick,
    CASE WHEN b.p2_diff_pg IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY b.window_games ORDER BY (b.p2_diff_pg IS NULL), b.p2_diff_pg DESC, b.team_tri
    ) END AS rank_p2_diff
  FROM base_summary b
),
advanced_ranked AS (
  SELECT
    a.*,
    g.scheduled_start_utc,
    ROW_NUMBER() OVER (
      PARTITION BY a.team_tri
      ORDER BY g.scheduled_start_utc DESC, a.game_pk DESC
    ) AS rn
  FROM team_game_advanced_features a
  JOIN games g ON g.game_pk=a.game_pk
  WHERE g.game_type IN (2,3)
),
advanced_summary AS (
  SELECT
    a.team_tri,
    w.window_games,
    COUNT(*) AS advanced_sample_size,
    AVG(a.xgf_pct_5v5) AS xgf_pct_5v5,
    60.0 * SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN COALESCE(a.xgf_5v5,0) ELSE 0 END)
      / NULLIF(SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN a.toi_5v5_minutes ELSE 0 END),0) AS xgf60_5v5,
    60.0 * SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN COALESCE(a.xga_5v5,0) ELSE 0 END)
      / NULLIF(SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN a.toi_5v5_minutes ELSE 0 END),0) AS xga60_5v5,
    AVG(a.corsi_for_pct_5v5) AS corsi_pct_5v5,
    AVG(a.fenwick_for_pct_5v5) AS fenwick_pct_5v5,
    CASE WHEN COUNT(a.pdo_5v5)*2 >= w.window_games THEN AVG(a.pdo_5v5) END AS pdo_5v5,
    CASE WHEN COUNT(a.goals_saved_above_expected)*2 >= w.window_games THEN AVG(a.goals_saved_above_expected) END AS gsax_5v5
  FROM advanced_ranked a
  JOIN windows w ON a.rn <= w.window_games
  GROUP BY a.team_tri, w.window_games
  HAVING COUNT(*) = w.window_games
     AND SUM(CASE WHEN COALESCE(a.toi_5v5_minutes,0)>0 THEN 1 ELSE 0 END) * 5 >= w.window_games * 4
),
advanced_scored AS (
  SELECT
    a.*,
    COUNT(*) OVER (PARTITION BY a.window_games) AS advanced_league_teams,
    CASE WHEN a.xgf_pct_5v5 IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY a.window_games ORDER BY (a.xgf_pct_5v5 IS NULL), a.xgf_pct_5v5 DESC, a.team_tri
    ) END AS rank_xgf_pct_5v5,
    CASE WHEN a.xgf60_5v5 IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY a.window_games ORDER BY (a.xgf60_5v5 IS NULL), a.xgf60_5v5 DESC, a.team_tri
    ) END AS rank_xgf60_5v5,
    CASE WHEN a.xga60_5v5 IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY a.window_games ORDER BY (a.xga60_5v5 IS NULL), a.xga60_5v5 ASC, a.team_tri
    ) END AS rank_xga60_5v5,
    CASE WHEN a.corsi_pct_5v5 IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY a.window_games ORDER BY (a.corsi_pct_5v5 IS NULL), a.corsi_pct_5v5 DESC, a.team_tri
    ) END AS rank_corsi_pct_5v5,
    CASE WHEN a.fenwick_pct_5v5 IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
      PARTITION BY a.window_games ORDER BY (a.fenwick_pct_5v5 IS NULL), a.fenwick_pct_5v5 DESC, a.team_tri
    ) END AS rank_fenwick_pct_5v5
  FROM advanced_summary a
)
INSERT OR REPLACE INTO team_current_snapshots(
  team_tri,window_games,as_of_utc,sample_size,league_teams,
  gf_pg,ga_pg,goal_diff_pg,total_pg,corsi_pct,fenwick_pct,p2_diff_pg,
  rank_gf,rank_ga,rank_goal_diff,rank_total,rank_corsi,rank_fenwick,rank_p2_diff,
  advanced_sample_size,advanced_league_teams,xgf_pct_5v5,xgf60_5v5,xga60_5v5,
  corsi_pct_5v5,fenwick_pct_5v5,pdo_5v5,gsax_5v5,
  rank_xgf_pct_5v5,rank_xgf60_5v5,rank_xga60_5v5,rank_corsi_pct_5v5,rank_fenwick_pct_5v5,
  computed_at
)
SELECT
  b.team_tri,b.window_games,b.as_of_utc,b.sample_size,b.league_teams,
  b.gf_pg,b.ga_pg,b.goal_diff_pg,b.total_pg,b.corsi_pct,b.fenwick_pct,b.p2_diff_pg,
  b.rank_gf,b.rank_ga,b.rank_goal_diff,b.rank_total,b.rank_corsi,b.rank_fenwick,b.rank_p2_diff,
  COALESCE(a.advanced_sample_size,0),a.advanced_league_teams,a.xgf_pct_5v5,a.xgf60_5v5,a.xga60_5v5,
  a.corsi_pct_5v5,a.fenwick_pct_5v5,a.pdo_5v5,a.gsax_5v5,
  a.rank_xgf_pct_5v5,a.rank_xgf60_5v5,a.rank_xga60_5v5,a.rank_corsi_pct_5v5,a.rank_fenwick_pct_5v5,
  CURRENT_TIMESTAMP
FROM base_scored b
LEFT JOIN advanced_scored a
  ON a.team_tri=b.team_tri AND a.window_games=b.window_games;

INSERT OR REPLACE INTO data_core_meta(meta_key,meta_value,updated_at)
SELECT 'compact.team_current_snapshots',CAST(COUNT(*) AS TEXT),CURRENT_TIMESTAMP
FROM team_current_snapshots;

INSERT OR REPLACE INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES(
  'build.current_created_at',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  CURRENT_TIMESTAMP
);
