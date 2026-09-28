-- Add a compact fraud-review index for the small subset of flagged sessions.
-- The migration runner wraps files in a transaction, so this intentionally
-- avoids CREATE INDEX CONCURRENTLY.

CREATE INDEX IF NOT EXISTS idx_game_sessions_flagged
  ON game_sessions (flagged)
  WHERE flagged = TRUE;
