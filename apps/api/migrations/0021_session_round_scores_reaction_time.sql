-- Ensure reaction_time_ms exists on session_round_scores.
-- Idempotent: the current initial.sql already includes this column, so
-- environments bootstrapped from it will see a no-op ALTER TABLE.
-- Older environments (pre-initial.sql fix) get the column added here.
-- Backfill derives per-round values from the denormalised columns on
-- game_sessions where the round-score row exists but reaction_time_ms is NULL.

ALTER TABLE session_round_scores
  ADD COLUMN IF NOT EXISTS reaction_time_ms INTEGER;

UPDATE session_round_scores srs
SET reaction_time_ms = gs.round_1_reaction_ms
FROM game_sessions gs
WHERE srs.session_id = gs.id
  AND srs.round = 1
  AND srs.reaction_time_ms IS NULL
  AND gs.round_1_reaction_ms IS NOT NULL;

UPDATE session_round_scores srs
SET reaction_time_ms = gs.round_2_reaction_ms
FROM game_sessions gs
WHERE srs.session_id = gs.id
  AND srs.round = 2
  AND srs.reaction_time_ms IS NULL
  AND gs.round_2_reaction_ms IS NOT NULL;

UPDATE session_round_scores srs
SET reaction_time_ms = gs.round_3_reaction_ms
FROM game_sessions gs
WHERE srs.session_id = gs.id
  AND srs.round = 3
  AND srs.reaction_time_ms IS NULL
  AND gs.round_3_reaction_ms IS NOT NULL;
