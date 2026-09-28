-- Migration 022: add indexes on fraud_flags to eliminate sequential scans on
-- the admin fraud review queries.
--
-- The admin fraud-flags endpoint filters by user_id and lists flags newest
-- first (ORDER BY created_at DESC). Without these indexes PostgreSQL performs a
-- sequential scan that degrades as the anti-cheat middleware accumulates rows.
--
-- idx_fraud_flags_user_id already exists in init.sql for fresh databases, so it
-- is added IF NOT EXISTS here to converge existing deployments.
-- idx_fraud_flags_created_at backs the time-ordered admin list.
--
-- CONCURRENTLY avoids locking the table during deployment, matching the pattern
-- in migration 003.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fraud_flags_user_id
  ON fraud_flags (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fraud_flags_created_at
  ON fraud_flags (created_at DESC);
