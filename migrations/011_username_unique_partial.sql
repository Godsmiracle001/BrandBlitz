-- DEPRECATED / SUPERSEDED:
-- This file in the root /migrations directory was never read by apps/api/scripts/migrate.ts.
-- The real production migration is located at:
-- apps/api/migrations/0024-username-unique-partial.sql
--
-- Keep this file for historical context only. Do not execute or reference this file.

-- Migration 011: Fix username UNIQUE constraint to handle NULLs properly
-- Issue #202: users.username is UNIQUE but nullable — multiple NULLs allowed
--
-- Problem: PostgreSQL UNIQUE allows multiple NULL rows, but we want
-- "every username is unique once chosen" (case-insensitive).
--
-- Solution: Use a partial unique index that only applies when username IS NOT NULL,
-- and make it case-insensitive to prevent "Alice" and "alice" collisions.

-- Drop the existing UNIQUE constraint on username
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

-- Create a partial unique index (case-insensitive, only when username IS NOT NULL)
CREATE UNIQUE INDEX users_username_unique 
  ON users (LOWER(username)) 
  WHERE username IS NOT NULL;

-- Add comment for documentation
COMMENT ON INDEX users_username_unique IS 
  'Ensures usernames are unique (case-insensitive) when set, allows multiple NULLs';
