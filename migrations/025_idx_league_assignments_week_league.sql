-- Migration 025: dedicated two-column index on league_assignments(week_start, league)
--
-- The weekly recalculation job in queues/processors/league.processor.ts queries
-- league_assignments filtered by week_start and grouped by league. The existing
-- 4-column index idx_league_assignments_week(week_start, league, group_id,
-- weekly_points DESC) optimises leaderboard ordering, not simple 2-column
-- equality filters. This dedicated index improves the recalculation query plan.
--
-- Using CONCURRENTLY so this can run without locking the table in production.
--
-- Down migration:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_league_assignments_week_league;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_assignments_week_league
  ON league_assignments (week_start, league);
