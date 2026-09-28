-- BrandBlitz PostgreSQL bootstrap.
-- Fresh installs load the baseline schema, then the forward migrations.
-- The files are included relative to this script so `psql -f init.sql` works
-- both in CI and in the Postgres container used by docker-compose.

\ir apps/api/migrations/00000-initial.sql
\ir apps/api/migrations/00001-hot-path-indexes.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATED_AT trigger helper (re-created idempotently)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG (runtime-tunable key/value store)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_config (key, value) VALUES
  ('anti_cheat.thresholds', '{"min_human_reaction_ms": 150, "max_human_reaction_ms": 30000}')
ON CONFLICT (key) DO NOTHING;