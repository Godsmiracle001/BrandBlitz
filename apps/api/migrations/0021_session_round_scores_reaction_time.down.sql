-- Down: drop reaction_time_ms from session_round_scores.
-- Only safe to run on environments where this migration added the column.
-- Environments bootstrapped from the current initial.sql (which already
-- includes the column) must NOT run this down migration in isolation.
ALTER TABLE session_round_scores
  DROP COLUMN IF EXISTS reaction_time_ms;
