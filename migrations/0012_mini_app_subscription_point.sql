ALTER TABLE subscriptions
  ADD COLUMN notify_point INTEGER NOT NULL DEFAULT 0 CHECK (notify_point IN (0, 1));
