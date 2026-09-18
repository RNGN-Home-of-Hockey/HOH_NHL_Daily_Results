PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS h2h_scoped_temp;

CREATE TEMP TABLE h2h_scoped_temp AS
SELECT f.*, '2Y_ALL' AS scope_key
FROM team_game_features f
WHERE f.season_id IN ('20242025','20252026')
  AND f.game_type IN (2,3);

INSERT INTO h2h_scoped_temp
SELECT f.*, 'S_' || f.season_id AS scope_key
FROM team_game_features f
WHERE f.season_id IN ('20242025','20252026')
  AND f.game_type IN (2,3);

INSERT INTO h2h_scoped_temp
SELECT f.*, '2Y_HOME' AS scope_key
FROM team_game_features f
WHERE f.season_id IN ('20242025','20252026')
  AND f.game_type IN (2,3)
  AND f.is_home = 1;

INSERT INTO h2h_scoped_temp
SELECT f.*, '2Y_AWAY' AS scope_key
FROM team_game_features f
WHERE f.season_id IN ('20242025','20252026')
  AND f.game_type IN (2,3)
  AND f.is_home = 0;

INSERT INTO h2h_scoped_temp
SELECT f.*, '2Y_REG' AS scope_key
FROM team_game_features f
WHERE f.season_id IN ('20242025','20252026')
  AND f.game_type = 2;

INSERT INTO h2h_scoped_temp
SELECT f.*, '2Y_PO' AS scope_key
FROM team_game_features f
WHERE f.season_id IN ('20242025','20252026')
  AND f.game_type = 3;

DELETE FROM team_h2h_snapshots
WHERE scope_key IN ('2Y_ALL','S_20242025','S_20252026','2Y_HOME','2Y_AWAY','2Y_REG','2Y_PO');

INSERT INTO team_h2h_snapshots (
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, computed_at
)
SELECT
  team_tri,
  opponent_tri,
  scope_key,
  COUNT(*) AS games,
  SUM(final_win) AS wins,
  COUNT(*) - SUM(final_win) AS losses,
  SUM(final_goals_for) AS goals_for,
  SUM(final_goals_against) AS goals_against,
  1.0 * SUM(final_goals_for) / COUNT(*) AS goals_for_pg,
  1.0 * SUM(final_goals_against) / COUNT(*) AS goals_against_pg,
  1.0 * SUM(total_goals) / COUNT(*) AS total_goals_pg,
  SUM(shots_for) AS shots_for,
  SUM(shots_against) AS shots_against,
  CASE WHEN SUM(COALESCE(shots_for,0)) + SUM(COALESCE(shots_against,0)) > 0
    THEN 100.0 * SUM(COALESCE(shots_for,0)) /
      (SUM(COALESCE(shots_for,0)) + SUM(COALESCE(shots_against,0)))
    ELSE NULL END AS shot_share_pct,
  SUM(corsi_for) AS corsi_for,
  SUM(corsi_against) AS corsi_against,
  CASE WHEN SUM(COALESCE(corsi_for,0)) + SUM(COALESCE(corsi_against,0)) > 0
    THEN 100.0 * SUM(COALESCE(corsi_for,0)) /
      (SUM(COALESCE(corsi_for,0)) + SUM(COALESCE(corsi_against,0)))
    ELSE NULL END AS corsi_for_pct,
  SUM(fenwick_for) AS fenwick_for,
  SUM(fenwick_against) AS fenwick_against,
  CASE WHEN SUM(COALESCE(fenwick_for,0)) + SUM(COALESCE(fenwick_against,0)) > 0
    THEN 100.0 * SUM(COALESCE(fenwick_for,0)) /
      (SUM(COALESCE(fenwick_for,0)) + SUM(COALESCE(fenwick_against,0)))
    ELSE NULL END AS fenwick_for_pct,
  SUM(power_play_goals_for) AS power_play_goals_for,
  SUM(power_play_goals_against) AS power_play_goals_against,
  SUM(hits_for) AS hits_for,
  SUM(hits_against) AS hits_against,
  SUM(pim_for) AS pim_for,
  SUM(pim_against) AS pim_against,
  CASE WHEN COUNT(first_goal_for) > 0
    THEN 100.0 * SUM(COALESCE(first_goal_for,0)) / COUNT(first_goal_for)
    ELSE NULL END AS first_goal_pct,
  1.0 * SUM(p1_goals_for - p1_goals_against) / COUNT(*) AS p1_goal_diff_pg,
  1.0 * SUM(p2_goals_for - p2_goals_against) / COUNT(*) AS p2_goal_diff_pg,
  1.0 * SUM(p3_goals_for - p3_goals_against) / COUNT(*) AS p3_goal_diff_pg,
  SUM(went_ot) AS ot_games,
  SUM(went_so) AS so_games,
  MAX(scheduled_start_utc) AS last_game_utc,
  '[' || GROUP_CONCAT(game_pk) || ']' AS evidence_game_pks_json,
  CURRENT_TIMESTAMP
FROM h2h_scoped_temp
GROUP BY team_tri, opponent_tri, scope_key;

INSERT INTO data_core_meta(meta_key, meta_value, updated_at)
SELECT 'h2h.snapshot_rows', CAST(COUNT(*) AS TEXT), CURRENT_TIMESTAMP
FROM team_h2h_snapshots
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;

DROP TABLE h2h_scoped_temp;
