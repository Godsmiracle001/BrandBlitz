-- #482: Record when a user was last active for dormancy checks and streak continuity.
ALTER TABLE users ADD COLUMN last_active_at TIMESTAMPTZ NULL;

-- Backfill from the most recent game session per user.
UPDATE users u
SET last_active_at = (
  SELECT MAX(gs.created_at)
  FROM game_sessions gs
  WHERE gs.user_id = u.id
);
