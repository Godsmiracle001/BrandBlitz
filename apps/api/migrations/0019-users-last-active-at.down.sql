-- Rollback #482
ALTER TABLE users DROP COLUMN IF EXISTS last_active_at;
