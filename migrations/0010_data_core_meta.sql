PRAGMA foreign_keys = ON;

-- Small key/value status table populated from the validated local warehouse.
-- Product health/overview routes read this instead of COUNT(*) scans over the
-- historical D1 tables, protecting the D1 Free row-read quota.
CREATE TABLE IF NOT EXISTS data_core_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_data_core_meta_updated
  ON data_core_meta(updated_at);
