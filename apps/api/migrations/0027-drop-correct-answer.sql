-- Migration 0027: Drop redundant correct_answer column from challenge_questions
-- Issue #208: challenge_questions has both correct_answer (string) and correct_option (A-D)
-- Solution: Drop correct_answer, keep only correct_option which is the source of truth

-- Drop the redundant correct_answer column
ALTER TABLE challenge_questions DROP COLUMN IF EXISTS correct_answer;

-- Add comment for documentation
COMMENT ON TABLE challenge_questions IS
  'Stores quiz questions for challenges. Uses correct_option (A-D) as source of truth for scoring.';
