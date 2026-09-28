-- Migration 0025: Brand webhooks and delivery tracking tables
-- Issue #1289

CREATE TABLE IF NOT EXISTS brand_webhooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  event_types TEXT[] NOT NULL DEFAULT '{"challenge.started","challenge.ended","challenge.settled"}',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_webhooks_brand_id ON brand_webhooks(brand_id);

CREATE TABLE IF NOT EXISTS brand_webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES brand_webhooks(id) ON DELETE CASCADE,
  brand_id        UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_webhook_deliveries_brand_id ON brand_webhook_deliveries(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_webhook_deliveries_webhook_id ON brand_webhook_deliveries(webhook_id);
