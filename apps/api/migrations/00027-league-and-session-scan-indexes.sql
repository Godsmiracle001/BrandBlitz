-- Indexes for the weekly league point aggregation (recalculate_league,
-- recalculateWeeklyPoints, GET /leagues/current) and the session-timeout sweep.

CREATE INDEX IF NOT EXISTS idx_game_sessions_completed_window
  ON game_sessions (completed_at)
  INCLUDE (user_id, total_score)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_game_sessions_open_last_activity
  ON game_sessions ((COALESCE(challenge_started_at, warmup_started_at, created_at)))
  WHERE status IN ('warmup', 'active');
