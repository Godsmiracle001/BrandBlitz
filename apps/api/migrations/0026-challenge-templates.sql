-- Migration 0026: Challenge templates for recurring/scheduled auto-spawned challenges
-- Issue #1291

CREATE TABLE IF NOT EXISTS challenge_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

  -- Challenge fields that will be cloned into each spawned challenge
  pool_amount_usdc   NUMERIC(20,7) NOT NULL,
  pool_amount_stroops BIGINT NOT NULL GENERATED ALWAYS AS (ROUND(pool_amount_usdc::numeric * 10000000)) STORED,
  max_players        INTEGER,
  duration_hours     INTEGER NOT NULL,

  -- Recurrence rule
  recurrence_rule    TEXT NOT NULL
    CONSTRAINT recurrence_rule_enum
      CHECK (recurrence_rule IN ('daily', 'weekly', 'biweekly', 'monthly', 'custom')),
  recurrence_cron    TEXT,
  recurrence_timezone TEXT NOT NULL DEFAULT 'UTC',

  -- State control: templates can be paused without deleting history
  status             TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT status_enum
      CHECK (status IN ('active', 'paused', 'deleted')),

  -- Idempotency key: last spawned period identifier so we never double-spawn
  last_spawned_period TEXT,
  last_spawned_at    TIMESTAMPTZ,

  -- Lifecycle soft-delete + timestamps
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_templates_brand_id
  ON challenge_templates(brand_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_challenge_templates_active
  ON challenge_templates(status) WHERE status = 'active' AND deleted_at IS NULL;

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS template_id UUID
    REFERENCES challenge_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_challenges_template_id ON challenges(template_id)
  WHERE template_id IS NOT NULL;

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS spawned_period TEXT;

CREATE INDEX IF NOT EXISTS idx_challenges_template_period
  ON challenges(template_id, spawned_period)
  WHERE template_id IS NOT NULL AND spawned_period IS NOT NULL;
