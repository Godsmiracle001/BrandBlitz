-- Migration 00027: First-run challenge onboarding flag (issue #1040).
-- FALSE until the user completes (or permanently skips) the first-run
-- tutorial overlay on the challenge page.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
