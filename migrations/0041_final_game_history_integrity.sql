PRAGMA foreign_keys = ON;

-- Historical broadcast math must never use scheduled/live placeholder score rows.
-- A non-final game can legitimately have 0:0 in games, but that is not a settled
-- historical result and must not exist in the materialized team feature layer.
DELETE FROM team_game_advanced_features
WHERE game_pk IN (
  SELECT game_pk FROM games
  WHERE UPPER(COALESCE(game_state,'')) NOT IN ('FINAL','OFF')
);

DELETE FROM team_game_features
WHERE game_pk IN (
  SELECT game_pk FROM games
  WHERE UPPER(COALESCE(game_state,'')) NOT IN ('FINAL','OFF')
);

-- These aggregates are rebuilt immediately by deploy-cloudflare after migrations.
DELETE FROM team_current_snapshots;

-- Force broadcast list badges to be recomputed from the cleaned history.
DELETE FROM broadcast_queue_summaries;

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('broadcast.history_integrity','final_games_only_v1',CURRENT_TIMESTAMP),
  ('team_game_features.version','2',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
