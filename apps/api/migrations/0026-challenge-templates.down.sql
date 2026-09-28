-- Migration 0026 down: remove challenge templates support

DROP INDEX IF EXISTS idx_challenges_template_period;
ALTER TABLE challenges DROP COLUMN IF EXISTS spawned_period;
DROP INDEX IF EXISTS idx_challenges_template_id;
ALTER TABLE challenges DROP COLUMN IF EXISTS template_id;

DROP INDEX IF EXISTS idx_challenge_templates_active;
DROP INDEX IF EXISTS idx_challenge_templates_brand_id;
DROP TABLE IF EXISTS challenge_templates;
