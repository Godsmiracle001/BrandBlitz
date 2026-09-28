-- Add an entity lookup index for admin audit trail pages.
-- The migration runner wraps files in a transaction, so this intentionally
-- avoids CREATE INDEX CONCURRENTLY.

CREATE INDEX IF NOT EXISTS idx_audit_log_entity_key
  ON audit_log (entity, entity_key);
