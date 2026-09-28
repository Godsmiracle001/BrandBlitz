-- #484: Track which admin last modified each app_config entry.
-- updated_at + its BEFORE UPDATE trigger already exist in the initial schema.
ALTER TABLE app_config ADD COLUMN updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
