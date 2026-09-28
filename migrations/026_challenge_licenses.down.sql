ALTER TABLE challenges DROP COLUMN IF EXISTS challenge_license_id;
DROP TABLE IF EXISTS challenge_licenses;
ALTER TABLE challenges
  DROP COLUMN IF EXISTS license_fee_bps,
  DROP COLUMN IF EXISTS licensing_available;
