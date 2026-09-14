PRAGMA foreign_keys = ON;

ALTER TABLE player_profile_meta ADD COLUMN birth_date TEXT;

CREATE INDEX IF NOT EXISTS idx_player_profile_meta_birth_date
  ON player_profile_meta(birth_date);
