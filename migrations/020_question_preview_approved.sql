-- Add `approved` column to challenge_questions for question preview workflow.
-- NULL = not yet reviewed, true = approved, false = flagged for regeneration.
ALTER TABLE challenge_questions ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT NULL;
