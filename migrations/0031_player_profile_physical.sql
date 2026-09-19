ALTER TABLE player_profile_meta ADD COLUMN height_cm INTEGER;
ALTER TABLE player_profile_meta ADD COLUMN weight_kg INTEGER;

CREATE INDEX IF NOT EXISTS idx_player_profile_meta_height_cm
  ON player_profile_meta(height_cm);

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES ('player_profile_meta.physical_v1','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
