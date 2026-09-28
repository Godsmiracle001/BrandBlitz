import { query } from "../index";

export interface ChallengeLicense {
  id: string;
  source_challenge_id: string;
  challenge_name?: string;
  licensor_brand_id: string;
  licensee_brand_id: string;
  fee_bps: number;
  created_at: string;
  licensor_brand_name?: string;
  licensee_brand_name?: string;
}

export interface LicenseOffer {
  challenge_id: string;
  challenge_name: string;
  licensor_brand_id: string;
  licensor_brand_name: string;
  fee_bps: number;
}

export async function listLicenseMarketplace(
  excludeBrandIds: string[] = []
): Promise<LicenseOffer[]> {
  const result = await query<LicenseOffer>(
    `SELECT c.id AS challenge_id,
            c.challenge_id AS challenge_name,
            c.brand_id AS licensor_brand_id,
            b.name AS licensor_brand_name,
            c.license_fee_bps AS fee_bps
     FROM challenges c
     JOIN brands b ON b.id = c.brand_id
     WHERE c.licensing_available = true
       AND c.deleted_at IS NULL
       AND b.deleted_at IS NULL
       AND NOT (c.brand_id = ANY($1::uuid[]))
     ORDER BY c.created_at DESC`,
    [excludeBrandIds]
  );
  return result.rows;
}

export async function acquireChallengeLicense(data: {
  sourceChallengeId: string;
  licenseeBrandId: string;
}): Promise<ChallengeLicense | null> {
  const result = await query<ChallengeLicense>(
    `INSERT INTO challenge_licenses
       (source_challenge_id, licensor_brand_id, licensee_brand_id, fee_bps)
     SELECT c.id, c.brand_id, $2, c.license_fee_bps
     FROM challenges c
     JOIN brands licensor ON licensor.id = c.brand_id AND licensor.deleted_at IS NULL
     WHERE c.id = $1
       AND c.licensing_available = true
       AND c.deleted_at IS NULL
       AND c.brand_id <> $2
     ON CONFLICT (source_challenge_id, licensee_brand_id) DO NOTHING
     RETURNING *`,
    [data.sourceChallengeId, data.licenseeBrandId]
  );
  return result.rows[0] ?? null;
}

export async function getBrandLicenses(brandId: string): Promise<{
  offered: LicenseOffer[];
  acquired: ChallengeLicense[];
  issued: ChallengeLicense[];
}> {
  const [offered, acquired, issued] = await Promise.all([
    query<LicenseOffer>(
      `SELECT c.id AS challenge_id, c.challenge_id AS challenge_name,
              c.brand_id AS licensor_brand_id, b.name AS licensor_brand_name,
              c.license_fee_bps AS fee_bps
       FROM challenges c JOIN brands b ON b.id = c.brand_id
       WHERE c.brand_id = $1 AND c.licensing_available = true AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC`,
      [brandId]
    ),
    query<ChallengeLicense>(
      `SELECT cl.*, c.challenge_id AS challenge_name, licensor.name AS licensor_brand_name
       FROM challenge_licenses cl
       JOIN challenges c ON c.id = cl.source_challenge_id
       JOIN brands licensor ON licensor.id = cl.licensor_brand_id
       WHERE cl.licensee_brand_id = $1 ORDER BY cl.created_at DESC`,
      [brandId]
    ),
    query<ChallengeLicense>(
      `SELECT cl.*, c.challenge_id AS challenge_name, licensee.name AS licensee_brand_name
       FROM challenge_licenses cl
       JOIN challenges c ON c.id = cl.source_challenge_id
       JOIN brands licensee ON licensee.id = cl.licensee_brand_id
       WHERE cl.licensor_brand_id = $1 ORDER BY cl.created_at DESC`,
      [brandId]
    ),
  ]);
  return {
    offered: offered.rows,
    acquired: acquired.rows,
    issued: issued.rows,
  };
}

export async function setChallengeLicenseOffer(data: {
  challengeId: string;
  brandId: string;
  available: boolean;
  feeBps: number;
}): Promise<LicenseOffer | null> {
  const result = await query<LicenseOffer>(
    `UPDATE challenges c
     SET licensing_available = $3, license_fee_bps = $4
     FROM brands b
     WHERE c.id = $1 AND c.brand_id = $2 AND b.id = c.brand_id
     RETURNING c.id AS challenge_id, c.challenge_id AS challenge_name,
               c.brand_id AS licensor_brand_id, b.name AS licensor_brand_name,
               c.license_fee_bps AS fee_bps`,
    [data.challengeId, data.brandId, data.available, data.feeBps]
  );
  return result.rows[0] ?? null;
}

export async function getUsableLicense(
  id: string,
  licenseeBrandId: string
): Promise<ChallengeLicense | null> {
  const result = await query<ChallengeLicense>(
    `SELECT * FROM challenge_licenses WHERE id = $1 AND licensee_brand_id = $2`,
    [id, licenseeBrandId]
  );
  return result.rows[0] ?? null;
}

export async function getLicensePayoutTerms(challengeId: string): Promise<{
  fee_bps: number;
  user_id: string;
  stellar_address: string | null;
} | null> {
  const result = await query<{
    fee_bps: number;
    user_id: string;
    stellar_address: string | null;
  }>(
    `SELECT cl.fee_bps, b.owner_user_id AS user_id, u.stellar_address
     FROM challenges c
     JOIN challenge_licenses cl ON cl.id = c.challenge_license_id
     JOIN brands b ON b.id = cl.licensor_brand_id
     JOIN users u ON u.id = b.owner_user_id
     WHERE c.id = $1`,
    [challengeId]
  );
  return result.rows[0] ?? null;
}
