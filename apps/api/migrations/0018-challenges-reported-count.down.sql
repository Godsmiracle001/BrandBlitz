-- Rollback #481
ALTER TABLE challenges DROP COLUMN IF EXISTS reported_count;
