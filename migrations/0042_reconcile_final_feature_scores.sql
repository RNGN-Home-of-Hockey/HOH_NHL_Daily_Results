PRAGMA foreign_keys = ON;

-- A FINAL/OFF flag alone is not sufficient: historical schedule rows can carry
-- stale/default scores. Keep team features only when both team rows reconcile
-- with the canonical game score and imported team boxscore totals.
DELETE FROM team_game_features
WHERE rowid IN (
  SELECT f.rowid
  FROM team_game_features f
  JOIN games g ON g.game_pk=f.game_pk
  LEFT JOIN team_game_stats own ON own.game_pk=f.game_pk AND own.team_tri=f.team_tri
  LEFT JOIN team_game_stats opp ON opp.game_pk=f.game_pk AND opp.team_tri=f.opponent_tri
  WHERE UPPER(COALESCE(g.game_state,'')) NOT IN ('FINAL','OFF')
     OR own.team_tri IS NULL
     OR opp.team_tri IS NULL
     OR f.final_goals_for <> CASE WHEN f.is_home=1 THEN g.home_score ELSE g.away_score END
     OR f.final_goals_against <> CASE WHEN f.is_home=1 THEN g.away_score ELSE g.home_score END
     OR own.goals <> CASE WHEN f.is_home=1 THEN g.home_score ELSE g.away_score END
     OR opp.goals <> CASE WHEN f.is_home=1 THEN g.away_score ELSE g.home_score END
);

-- Advanced rows must never outlive their trusted base game row.
DELETE FROM team_game_advanced_features
WHERE NOT EXISTS (
  SELECT 1 FROM team_game_features f
  WHERE f.game_pk=team_game_advanced_features.game_pk
    AND f.team_tri=team_game_advanced_features.team_tri
);

-- Deploy refreshes these immediately after migrations; clear stale aggregates
-- and queue badges first so no old math survives the cutover.
DELETE FROM team_current_snapshots;
DELETE FROM broadcast_queue_summaries;

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('broadcast.history_integrity','final_score_reconciled_v2',CURRENT_TIMESTAMP),
  ('team_game_features.validation','games+team_game_stats',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
