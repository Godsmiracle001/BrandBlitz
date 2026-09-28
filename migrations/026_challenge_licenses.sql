-- Opt-in brand-to-brand challenge format licensing.
ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS licensing_available boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS license_fee_bps integer NOT NULL DEFAULT 0
    CHECK (license_fee_bps BETWEEN 0 AND 5000);

CREATE TABLE IF NOT EXISTS challenge_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE RESTRICT,
  licensor_brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  licensee_brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_licenses_distinct_brands CHECK (licensor_brand_id <> licensee_brand_id),
  CONSTRAINT challenge_licenses_unique_acquisition UNIQUE (source_challenge_id, licensee_brand_id)
);

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS challenge_license_id uuid
    REFERENCES challenge_licenses(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_challenge_licenses_licensor
  ON challenge_licenses (licensor_brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenge_licenses_licensee
  ON challenge_licenses (licensee_brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_license
  ON challenges (challenge_license_id)
  WHERE challenge_license_id IS NOT NULL;
