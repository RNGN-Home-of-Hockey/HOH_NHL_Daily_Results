PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_shot_context_game (
  game_pk INTEGER NOT NULL,
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  is_home INTEGER NOT NULL CHECK (is_home IN (0,1)),
  shot_attempts INTEGER NOT NULL DEFAULT 0,
  unblocked_attempts INTEGER NOT NULL DEFAULT 0,
  shots_on_goal INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  hoh_slot_attempts INTEGER NOT NULL DEFAULT 0,
  hoh_slot_sog INTEGER NOT NULL DEFAULT 0,
  hoh_slot_goals INTEGER NOT NULL DEFAULT 0,
  rebound_attempts INTEGER NOT NULL DEFAULT 0,
  rebound_sog INTEGER NOT NULL DEFAULT 0,
  rebound_goals INTEGER NOT NULL DEFAULT 0,
  quick_transition_attempts INTEGER NOT NULL DEFAULT 0,
  quick_transition_sog INTEGER NOT NULL DEFAULT 0,
  quick_transition_goals INTEGER NOT NULL DEFAULT 0,
  attempts_tied INTEGER NOT NULL DEFAULT 0,
  attempts_leading INTEGER NOT NULL DEFAULT 0,
  attempts_trailing INTEGER NOT NULL DEFAULT 0,
  avg_shot_distance_ft REAL,
  avg_shot_angle_deg REAL,
  wrist_attempts INTEGER NOT NULL DEFAULT 0,
  snap_attempts INTEGER NOT NULL DEFAULT 0,
  slap_attempts INTEGER NOT NULL DEFAULT 0,
  backhand_attempts INTEGER NOT NULL DEFAULT 0,
  tip_attempts INTEGER NOT NULL DEFAULT 0,
  deflected_attempts INTEGER NOT NULL DEFAULT 0,
  other_attempts INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, team_tri)
);

CREATE INDEX IF NOT EXISTS idx_team_shot_context_team
  ON team_shot_context_game(team_tri, season_id, game_type, game_pk);

CREATE INDEX IF NOT EXISTS idx_team_shot_context_matchup
  ON team_shot_context_game(team_tri, opponent_tri, season_id, game_pk);

CREATE TABLE IF NOT EXISTS player_shot_context_game (
  game_pk INTEGER NOT NULL,
  season_id TEXT NOT NULL,
  game_type INTEGER NOT NULL,
  team_tri TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  shot_attempts INTEGER NOT NULL DEFAULT 0,
  unblocked_attempts INTEGER NOT NULL DEFAULT 0,
  shots_on_goal INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  hoh_slot_attempts INTEGER NOT NULL DEFAULT 0,
  hoh_slot_sog INTEGER NOT NULL DEFAULT 0,
  hoh_slot_goals INTEGER NOT NULL DEFAULT 0,
  rebound_attempts INTEGER NOT NULL DEFAULT 0,
  rebound_sog INTEGER NOT NULL DEFAULT 0,
  rebound_goals INTEGER NOT NULL DEFAULT 0,
  quick_transition_attempts INTEGER NOT NULL DEFAULT 0,
  quick_transition_sog INTEGER NOT NULL DEFAULT 0,
  quick_transition_goals INTEGER NOT NULL DEFAULT 0,
  avg_shot_distance_ft REAL,
  avg_shot_angle_deg REAL,
  max_shot_distance_ft REAL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_pk, player_id)
);

CREATE INDEX IF NOT EXISTS idx_player_shot_context_player
  ON player_shot_context_game(player_id, season_id, game_type, game_pk);

CREATE INDEX IF NOT EXISTS idx_player_shot_context_team
  ON player_shot_context_game(team_tri, season_id, game_type, game_pk);

CREATE TABLE IF NOT EXISTS team_shot_context_h2h (
  team_tri TEXT NOT NULL,
  opponent_tri TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  games INTEGER NOT NULL,
  shot_attempts_pg REAL,
  sog_pg REAL,
  goals_pg REAL,
  hoh_slot_attempts_pg REAL,
  hoh_slot_sog_pg REAL,
  rebound_attempts_pg REAL,
  quick_transition_attempts_pg REAL,
  slot_goal_share_pct REAL,
  rebound_goal_share_pct REAL,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_tri, opponent_tri, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_team_shot_context_h2h
  ON team_shot_context_h2h(team_tri, opponent_tri, scope_key);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES
  ('shot_context.version','1',CURRENT_TIMESTAMP),
  ('shot_context.definition','HOH-derived from official NHL play-by-play; not official NHL xG/high-danger',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value=excluded.meta_value,
  updated_at=CURRENT_TIMESTAMP;
