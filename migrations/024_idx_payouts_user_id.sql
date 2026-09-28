-- Migration 024: ensure index on payouts(user_id) for earnings history queries
--
-- services/payout.ts and routes/users.ts query the payouts table filtered by
-- user_id to compute earnings history and display payout records. Without this
-- index, lookups degrade linearly as the payouts table grows with Stellar
-- settlement records.
--
-- The index already exists on fresh databases (declared in init.sql), so this
-- migration is idempotent via IF NOT EXISTS and converges the migration path.
--
-- Using CONCURRENTLY so this can run without locking the table in production.
--
-- Down migration:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_payouts_user_id;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_user_id
  ON payouts (user_id);
