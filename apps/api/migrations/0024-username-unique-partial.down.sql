-- Rollback migration 0024
DROP INDEX IF EXISTS users_username_unique;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
