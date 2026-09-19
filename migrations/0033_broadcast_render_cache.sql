ALTER TABLE broadcast_cards ADD COLUMN render_hash TEXT;
ALTER TABLE broadcast_cards ADD COLUMN render_png_base64 TEXT;
ALTER TABLE broadcast_cards ADD COLUMN render_bytes INTEGER;
ALTER TABLE broadcast_cards ADD COLUMN rendered_at TEXT;

CREATE INDEX IF NOT EXISTS idx_broadcast_cards_render_hash
  ON broadcast_cards(render_hash);
