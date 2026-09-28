-- Cursor-pagination indexes for keyset-based offset-free queries.
-- Each index matches the ORDER BY + cursor columns used in keyset pagination.

CREATE INDEX IF NOT EXISTS idx_challenges_active_cursor
  ON challenges (pool_amount_stroops DESC, id DESC)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_challenges_brand_cursor
  ON challenges (brand_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_game_sessions_leaderboard_cursor
  ON game_sessions (challenge_id, total_score DESC, completed_at ASC, id ASC)
  WHERE status = 'completed' AND flagged = FALSE AND is_practice = FALSE;

CREATE INDEX IF NOT EXISTS idx_game_sessions_archive_leaderboard_cursor
  ON game_sessions_archive (challenge_id, total_score DESC, challenge_ended_at ASC, id ASC)
  WHERE flagged = FALSE AND is_practice = FALSE AND status = 'completed';

CREATE INDEX IF NOT EXISTS idx_users_admin_list_cursor
  ON users (suspended_at DESC NULLS LAST, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fraud_flags_list_cursor
  ON fraud_flags (created_at DESC, id DESC);
