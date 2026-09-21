-- One independent preview/on-air lane per NHL game.
-- The application now scopes status transitions by game_pk; these indexes
-- make that invariant explicit at the database layer as well.

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_cards_one_shown_per_game
  ON broadcast_cards(game_pk)
  WHERE status='shown';

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_cards_one_preview_per_game
  ON broadcast_cards(game_pk)
  WHERE status='preview';
