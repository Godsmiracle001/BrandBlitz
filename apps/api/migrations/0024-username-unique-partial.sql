-- Migration 0024: Fix username UNIQUE constraint to handle NULLs properly and enforce case-insensitive uniqueness
-- Issue #202 / #972

-- Drop the existing UNIQUE constraint on username (created by plain username TEXT UNIQUE in initial schema)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

-- Create a partial unique index (case-insensitive, only when username IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users (LOWER(username))
  WHERE username IS NOT NULL;

-- Add comment for documentation
COMMENT ON INDEX users_username_unique IS
  'Ensures usernames are unique (case-insensitive) when set, allows multiple NULLs';
