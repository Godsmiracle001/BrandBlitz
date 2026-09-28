ALTER TABLE game_sessions
  DROP COLUMN IF EXISTS abandon_reason;

-- Drop the enum only after the column referencing it is removed.
DO $$ BEGIN
  DROP TYPE session_abandon_reason;
EXCEPTION WHEN dependent_objects_still_exist THEN NULL;
END $$;
