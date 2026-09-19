ALTER TABLE app_user_profiles ADD COLUMN no_spoilers INTEGER NOT NULL DEFAULT 0;

INSERT INTO data_core_meta(meta_key,meta_value,updated_at)
VALUES ('app_user_profiles.no_spoilers','1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
