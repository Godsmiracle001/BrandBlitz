-- #481: Track how many times a challenge has been reported for content moderation.
ALTER TABLE challenges ADD COLUMN reported_count INT NOT NULL DEFAULT 0;
