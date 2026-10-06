ALTER TABLE nba_sync_manifest ADD COLUMN schedule_payload_sha256 TEXT;
ALTER TABLE nba_sync_manifest ADD COLUMN boxscore_payload_sha256 TEXT;
ALTER TABLE nba_sync_manifest ADD COLUMN failed_game_count INTEGER NOT NULL DEFAULT 0;
