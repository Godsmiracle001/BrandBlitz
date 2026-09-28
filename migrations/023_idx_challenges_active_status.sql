-- Migration 023: partial index on challenges(status) WHERE status = 'active'
--
-- The active-challenge listing query in db/queries/challenges.ts filters
-- exclusively on status = 'active'. A partial index is smaller than a full
-- index on status and the planner will prefer it for this highly selective
-- predicate. The vast majority of challenges are in terminal states, so
-- maintenance cost of the partial index is minimal.
--
-- Using CONCURRENTLY so this can run without locking the table in production.
--
-- Down migration:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_challenges_active_status;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_challenges_active_status
  ON challenges (status)
  WHERE status = 'active';
