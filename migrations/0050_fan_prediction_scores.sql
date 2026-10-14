-- The game of the fans: after the pick of the winner a fan may also guess the exact final score (+25 XP when it is right).
ALTER TABLE fan_predictions ADD COLUMN score_home INTEGER;
ALTER TABLE fan_predictions ADD COLUMN score_away INTEGER;
-- 1 = the exact score was guessed, 0 = it was not (or there was no score), NULL = not settled yet
ALTER TABLE fan_predictions ADD COLUMN exact INTEGER;
