PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_h2h_snapshots (
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  games INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  goals_for INTEGER NOT NULL,
  goals_against INTEGER NOT NULL,
  goals_for_pg REAL,
  goals_against_pg REAL,
  total_goals_pg REAL,
  shots_for INTEGER,
  shots_against INTEGER,
  shot_share_pct REAL,
  corsi_for INTEGER,
  corsi_against INTEGER,
  corsi_for_pct REAL,
  fenwick_for INTEGER,
  fenwick_against INTEGER,
  fenwick_for_pct REAL,
  power_play_goals_for INTEGER,
  power_play_goals_against INTEGER,
  hits_for INTEGER,
  hits_against INTEGER,
  pim_for INTEGER,
  pim_against INTEGER,
  first_goal_pct REAL,
  p1_goal_diff_pg REAL,
  p2_goal_diff_pg REAL,
  p3_goal_diff_pg REAL,
  ot_games INTEGER NOT NULL DEFAULT 0,
  so_games INTEGER NOT NULL DEFAULT 0,
  last_game_utc TEXT,
  evidence_game_pks_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_tri, opponent_tri, scope_key),
  FOREIGN KEY (team_tri) REFERENCES teams(tri_code),
  FOREIGN KEY (opponent_tri) REFERENCES teams(tri_code)
);

CREATE INDEX IF NOT EXISTS idx_team_h2h_lookup
  ON team_h2h_snapshots(team_tri, opponent_tri, scope_key);

CREATE INDEX IF NOT EXISTS idx_team_h2h_opponent
  ON team_h2h_snapshots(opponent_tri, team_tri, scope_key);

CREATE TABLE IF NOT EXISTS nhl_official_stat_reports (
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('team','skater','goalie')),
  report_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  team_tri TEXT,
  player_id INTEGER,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season_id, game_type, entity_type, report_name, row_key)
);

CREATE INDEX IF NOT EXISTS idx_nhl_official_reports_team
  ON nhl_official_stat_reports(season_id, game_type, entity_type, team_tri, report_name);

CREATE INDEX IF NOT EXISTS idx_nhl_official_reports_player
  ON nhl_official_stat_reports(player_id, season_id, game_type, entity_type, report_name);

WITH base AS (
  SELECT *
  FROM team_game_features
  WHERE season_id IN ('20242025','20252026')
    AND game_type IN (2,3)
),
scoped AS (
  SELECT b.*, '2Y_ALL' AS scope_key FROM base b
  UNION ALL
  SELECT b.*, 'S_' || b.season_id AS scope_key FROM base b
  UNION ALL
  SELECT b.*, '2Y_HOME' AS scope_key FROM base b WHERE b.is_home = 1
  UNION ALL
  SELECT b.*, '2Y_AWAY' AS scope_key FROM base b WHERE b.is_home = 0
  UNION ALL
  SELECT b.*, '2Y_REG' AS scope_key FROM base b WHERE b.game_type = 2
  UNION ALL
  SELECT b.*, '2Y_PO' AS scope_key FROM base b WHERE b.game_type = 3
),
agg AS (
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
    '[' || GROUP_CONCAT(game_pk) || ']' AS evidence_game_pks_json
  FROM scoped
  GROUP BY team_tri, opponent_tri, scope_key
)
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
  team_tri, opponent_tri, scope_key, games, wins, losses,
  goals_for, goals_against, goals_for_pg, goals_against_pg, total_goals_pg,
  shots_for, shots_against, shot_share_pct,
  corsi_for, corsi_against, corsi_for_pct,
  fenwick_for, fenwick_against, fenwick_for_pct,
  power_play_goals_for, power_play_goals_against,
  hits_for, hits_against, pim_for, pim_against,
  first_goal_pct, p1_goal_diff_pg, p2_goal_diff_pg, p3_goal_diff_pg,
  ot_games, so_games, last_game_utc, evidence_game_pks_json, CURRENT_TIMESTAMP
FROM agg
WHERE true
ON CONFLICT(team_tri, opponent_tri, scope_key) DO UPDATE SET
  games=excluded.games,
  wins=excluded.wins,
  losses=excluded.losses,
  goals_for=excluded.goals_for,
  goals_against=excluded.goals_against,
  goals_for_pg=excluded.goals_for_pg,
  goals_against_pg=excluded.goals_against_pg,
  total_goals_pg=excluded.total_goals_pg,
  shots_for=excluded.shots_for,
  shots_against=excluded.shots_against,
  shot_share_pct=excluded.shot_share_pct,
  corsi_for=excluded.corsi_for,
  corsi_against=excluded.corsi_against,
  corsi_for_pct=excluded.corsi_for_pct,
  fenwick_for=excluded.fenwick_for,
  fenwick_against=excluded.fenwick_against,
  fenwick_for_pct=excluded.fenwick_for_pct,
  power_play_goals_for=excluded.power_play_goals_for,
  power_play_goals_against=excluded.power_play_goals_against,
  hits_for=excluded.hits_for,
  hits_against=excluded.hits_against,
  pim_for=excluded.pim_for,
  pim_against=excluded.pim_against,
  first_goal_pct=excluded.first_goal_pct,
  p1_goal_diff_pg=excluded.p1_goal_diff_pg,
  p2_goal_diff_pg=excluded.p2_goal_diff_pg,
  p3_goal_diff_pg=excluded.p3_goal_diff_pg,
  ot_games=excluded.ot_games,
  so_games=excluded.so_games,
  last_game_utc=excluded.last_game_utc,
  evidence_game_pks_json=excluded.evidence_game_pks_json,
  computed_at=CURRENT_TIMESTAMP;

INSERT INTO data_core_meta(meta_key, meta_value, updated_at)
VALUES
  ('h2h.seasons', '20242025,20252026', CURRENT_TIMESTAMP),
  ('h2h.version', '1', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
