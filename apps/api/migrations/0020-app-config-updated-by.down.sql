-- Rollback #484
ALTER TABLE app_config DROP COLUMN IF EXISTS updated_by;
