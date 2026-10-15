-- The game of the fans, package 1 of the owner's list (2026-10-15):
--   streak        how many right picks in a row this pick made (0 when it was wrong), written at the settlement;
--   streak_bonus  the extra XP the pick brought when the streak reached 5, 10, 15… (⭐, ⭐⭐, ⭐⭐⭐), already inside xp;
--   public_board  1 = the person is in the table under the nickname, 0 = «только мне»: a hidden fan without name or photo.
ALTER TABLE fan_predictions ADD COLUMN streak INTEGER;
ALTER TABLE fan_predictions ADD COLUMN streak_bonus INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fan_profiles ADD COLUMN public_board INTEGER NOT NULL DEFAULT 1;
