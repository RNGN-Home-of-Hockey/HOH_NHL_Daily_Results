ALTER TABLE app_user_profiles ADD COLUMN display_username_norm TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_profiles_username_norm
  ON app_user_profiles(display_username_norm)
  WHERE display_username_norm IS NOT NULL AND TRIM(display_username_norm) <> '';

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES ('app_user_profiles.username_norm','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
