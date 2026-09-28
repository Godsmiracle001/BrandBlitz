import { BUCKETS, getPublicUrl } from "@brandblitz/storage";
import { query } from "../index";

export interface Brand {
  id: string;
  owner_user_id: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  tagline: string | null;
  brand_story: string | null;
  usp: string | null;
  product_image_keys: string[];
  question_template: Record<string, unknown> | null;
  deleted_at?: string | null;
  created_at: string;
}

export type BrandApi = Brand & {
  product_image_urls: string[];
};

/** Public-safe brand data. Owner identity and internal deletion metadata stay private. */
export type PublicBrand = Pick<
  Brand,
  | "id"
  | "name"
  | "logo_url"
  | "primary_color"
  | "secondary_color"
  | "tagline"
  | "brand_story"
  | "usp"
  | "product_image_keys"
  | "created_at"
>;

export function getProductImageUrls(brand: Pick<Brand, "product_image_keys">): string[] {
  return (brand.product_image_keys ?? []).map((key) => getPublicUrl(BUCKETS.BRAND_ASSETS, key));
}

export function toBrandApi(brand: Brand): BrandApi {
  return {
    ...brand,
    product_image_urls: getProductImageUrls(brand),
  };
}

export function toPublicBrandApi(brand: PublicBrand): PublicBrand & {
  product_image_urls: string[];
} {
  return {
    ...brand,
    product_image_urls: getProductImageUrls(brand),
  };
}

export async function createBrand(data: Omit<Brand, "id" | "created_at">): Promise<Brand> {
  const result = await query<Brand>(
    `INSERT INTO brands
       (owner_user_id, name, logo_url, primary_color, secondary_color,
        tagline, brand_story, usp, product_image_keys)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      data.owner_user_id,
      data.name,
      data.logo_url,
      data.primary_color,
      data.secondary_color,
      data.tagline,
      data.brand_story,
      data.usp,
      data.product_image_keys,
    ]
  );
  return result.rows[0];
}

export async function getBrandsByOwner(ownerUserId: string): Promise<Brand[]> {
  const result = await query<Brand>(
    "SELECT * FROM brands WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
    [ownerUserId]
  );
  return result.rows;
}

export async function getBrandById(id: string): Promise<Brand | null> {
  const result = await query<Brand>("SELECT * FROM brands WHERE id = $1 AND deleted_at IS NULL", [id]);
  return result.rows[0] ?? null;
}

export async function getPublicBrandById(id: string): Promise<PublicBrand | null> {
  const result = await query<PublicBrand>(
    `SELECT id, name, logo_url, primary_color, secondary_color, tagline,
            brand_story, usp, product_image_keys, created_at
     FROM brands WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getPublicBrands(limit = 50): Promise<PublicBrand[]> {
  const result = await query<PublicBrand>(
    `SELECT id, name, logo_url, primary_color, secondary_color, tagline,
            brand_story, usp, product_image_keys, created_at
     FROM brands b
     WHERE b.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM challenges c
         WHERE c.brand_id = b.id
           AND c.status = 'active'
           AND c.deleted_at IS NULL
       )
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getBrandMetaById(
  id: string
): Promise<Pick<Brand, "id" | "owner_user_id" | "deleted_at"> | null> {
  const result = await query<Pick<Brand, "id" | "owner_user_id" | "deleted_at">>(
    "SELECT id, owner_user_id, deleted_at FROM brands WHERE id = $1 /* include_deleted */",
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Fetch recent brands to use as distractor pool when generating challenge questions.
 * Excludes the current brand and caps results at 20.
 */
export async function getActiveDistractorBrands(excludeBrandId: string): Promise<Brand[]> {
  const result = await query<Brand>(
    `SELECT *
     FROM brands
     WHERE id <> $1 AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 20`,
    [excludeBrandId]
  );

  // Defensive cap in case query behavior changes in the future.
  return result.rows.slice(0, 20);
}

/**
 * Columns `updateBrand` is permitted to write. The UPDATE statement interpolates
 * column names into its SET clause, so these identifiers MUST come from this
 * fixed allowlist — never from caller-supplied object keys — to keep the query
 * injection-proof (the values are already parameterised; the identifiers are
 * what an attacker could otherwise smuggle in via a crafted key). See #113.
 */
const UPDATABLE_BRAND_COLUMNS = [
  "name",
  "logo_url",
  "primary_color",
  "secondary_color",
  "tagline",
  "brand_story",
  "usp",
  "product_image_1_url",
  "product_image_2_url",
  "question_template",
] as const;

type UpdatableBrandColumn = (typeof UPDATABLE_BRAND_COLUMNS)[number];

export async function updateBrand(
  id: string,
  ownerUserId: string,
  updates: Partial<Pick<Brand, UpdatableBrandColumn>>
): Promise<Brand | null> {
  const fields = Object.keys(updates);
  if (fields.length === 0) return getBrandById(id);

  // Fail closed: reject any key that is not an explicitly allowed column before
  // it can reach the dynamically-built SET clause. Without this, a crafted key
  // (e.g. "name = '' , deleted_at = NOW() --") would be SQL injection even
  // though the bound values below are parameterised.
  const allowed = new Set<string>(UPDATABLE_BRAND_COLUMNS);
  const invalid = fields.filter((f) => !allowed.has(f));
  if (invalid.length > 0) {
    throw new Error(`updateBrand: disallowed column(s): ${invalid.join(", ")}`);
  }

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const values = fields.map((f) => (updates as Record<string, unknown>)[f]);

  const result = await query<Brand>(
    `UPDATE brands SET ${setClause} WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL RETURNING *`,
    [id, ownerUserId, ...values]
  );
  return result.rows[0] ?? null;
}

export async function deleteBrand(
  id: string,
  ownerUserId?: string,
): Promise<{ deletedAt: string; cancelledChallenges: number } | null> {
  const result = await query<{ deleted_at: string; cancelled_count: number }>(
    `WITH deleted_brand AS (
       UPDATE brands
       SET deleted_at = NOW()
       WHERE id = $1
         AND deleted_at IS NULL
         AND ($2::uuid IS NULL OR owner_user_id = $2)
       RETURNING id, deleted_at
     ),
     cancelled AS (
       UPDATE challenges
       SET status = 'cancelled'
       WHERE brand_id IN (SELECT id FROM deleted_brand)
         AND status IN ('pending_deposit', 'active')
         AND deleted_at IS NULL
       RETURNING id
     )
     SELECT db.deleted_at, COUNT(c.id)::int AS cancelled_count
     FROM deleted_brand db
     LEFT JOIN cancelled c ON TRUE
     GROUP BY db.deleted_at`,
    [id, ownerUserId ?? null],
  );
  const row = result.rows[0];
  return row
    ? {
        deletedAt: row.deleted_at,
        cancelledChallenges: row.cancelled_count,
      }
    : null;
}

export interface BrandChallengeStats {
  brand_id: string;
  challenge_id: string;
  total_sessions: number;
  completed_sessions: number;
  avg_total_score: number | null;
  unique_players: number;
  payout_total_stroops: number;
}

export async function getBrandChallengeStats(brandId: string): Promise<BrandChallengeStats[]> {
  const result = await query<BrandChallengeStats>(
    `SELECT * FROM brand_challenge_stats WHERE brand_id = $1`,
    [brandId]
  );
  return result.rows;
}
