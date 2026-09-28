-- Per-brand question prompt override stored as JSONB.
-- NULL (the default) means use the global default prompt structure for all
-- three rounds. A non-null value allows brand owners to override question_text
-- and/or prompt_type per round via the PATCH /brands/:id endpoint.
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS question_template JSONB;
