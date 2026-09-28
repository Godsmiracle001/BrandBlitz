-- Rollback migration 00027
ALTER TABLE users DROP COLUMN IF EXISTS onboarding_completed;
