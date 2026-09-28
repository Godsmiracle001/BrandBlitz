-- Records why a game session was abandoned so analytics and fraud detection
-- can distinguish timeout, explicit player quit, and server-error closures.
-- NULL means the session completed normally (status = 'completed').

DO $$ BEGIN
  CREATE TYPE session_abandon_reason AS ENUM ('timeout', 'error', 'explicit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS abandon_reason session_abandon_reason;
