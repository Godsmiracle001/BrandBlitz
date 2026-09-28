import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `brands_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options");
  const searchPathOption = `-c search_path=${schema}`;
  url.searchParams.set(
    "options",
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption
  );
  return url.toString();
}

if (originalDatabaseUrl) {
  process.env.DATABASE_URL = withSearchPath(originalDatabaseUrl, schemaName);
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

describeIntegration("brands db queries", () => {
  let query: typeof import("../index").query;
  let closeDb: typeof import("../index").closeDb;
  let brands: typeof import("./brands");

  async function createUser(emailPrefix: string): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2)
       RETURNING id`,
      [`${emailPrefix}-${randomUUID()}@example.test`, emailPrefix]
    );
    return result.rows[0].id;
  }

  beforeAll(async () => {
    const db = await import("../index");
    query = db.query;
    closeDb = db.closeDb;
    brands = await import("./brands");

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL
      )
    `);

    await query(`
      CREATE TABLE brands (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        logo_url TEXT,
        primary_color TEXT DEFAULT '#6366f1',
        secondary_color TEXT DEFAULT '#a5b4fc',
        tagline TEXT,
        brand_story TEXT,
        usp TEXT,
        product_image_keys TEXT[] NOT NULL DEFAULT '{}',
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    if (query) {
      await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    if (closeDb) {
      await closeDb();
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  describe("createBrand", () => {
    it("inserts and returns the row with all fields", async () => {
      const ownerId = await createUser("create-brand");
      const data = {
        owner_user_id: ownerId,
        name: "Test Brand",
        logo_url: "logo.png",
        primary_color: "#000",
        secondary_color: "#fff",
        tagline: "Just test it",
        brand_story: "A long story",
        usp: "Very unique",
        product_image_keys: ["p1.png", "p2.png"],
      };
      const result = await brands.createBrand(data);
      expect(result.id).toBeTruthy();
      expect(result.created_at).toBeTruthy();
      expect(result.name).toBe("Test Brand");
      expect(result.owner_user_id).toBe(ownerId);
      expect(result.logo_url).toBe("logo.png");
    });
  });

  describe("getBrandsByOwner", () => {
    it("returns owner's brands; excludes others; orders by created_at DESC", async () => {
      const owner1 = await createUser("owner1");
      const owner2 = await createUser("owner2");

      const b1 = await brands.createBrand({
        owner_user_id: owner1,
        name: "B1",
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });

      // Provide order spacing
      await new Promise((r) => setTimeout(r, 10));

      const b2 = await brands.createBrand({
        owner_user_id: owner1,
        name: "B2",
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });

      await brands.createBrand({
        owner_user_id: owner2,
        name: "B3",
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });

      const o1Brands = await brands.getBrandsByOwner(owner1);
      
      expect(o1Brands).toHaveLength(2);
      expect(o1Brands[0].id).toBe(b2.id); // Descending
      expect(o1Brands[1].id).toBe(b1.id);
    });
  });

  describe("getBrandById", () => {
    it("returns a row or null; no 500s", async () => {
      const ownerId = await createUser("get-by-id");
      const brand = await brands.createBrand({
        owner_user_id: ownerId,
        name: "Test Brand 4",
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });

      const found = await brands.getBrandById(brand.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(brand.id);

      const notFound = await brands.getBrandById(randomUUID());
      expect(notFound).toBeNull();
    });
  });

  describe("updateBrand", () => {
    it("partial update, leaves unchanged fields intact", async () => {
      const ownerId = await createUser("update-owner");
      const brand = await brands.createBrand({
        owner_user_id: ownerId,
        name: "Old Name",
        tagline: "Old Tagline",
        logo_url: "old.png",
        primary_color: null, secondary_color: null, brand_story: null, usp: null, product_image_keys: []
      });

      const updated = await brands.updateBrand(brand.id, ownerId, {
        name: "New Name",
        tagline: null
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("New Name");
      expect(updated?.tagline).toBeNull();
      expect(updated?.logo_url).toBe("old.png");
      expect(updated?.id).toBe(brand.id);
    });
    
    it("returns unmodified brand if empty updates", async () => {
      const ownerId = await createUser("update-empty");
      const brand = await brands.createBrand({
        owner_user_id: ownerId,
        name: "Name",
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });
      const updated = await brands.updateBrand(brand.id, ownerId, {});
      expect(updated?.id).toBe(brand.id);
    });
  });

  describe("deleteBrand", () => {
    it("stub a test documenting the intended behaviour so the delete endpoint can land", async () => {
      const owner1 = await createUser("del1");
      const owner2 = await createUser("del2");

      const brand = await brands.createBrand({
        owner_user_id: owner1,
        name: "To Delete",
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });

      // Wrong owner
      const deletedWrong = await brands.deleteBrand(brand.id, owner2);
      expect(deletedWrong).toBeNull();

      const found = await brands.getBrandById(brand.id);
      expect(found).not.toBeNull();

      // Right owner
      const deletedRight = await brands.deleteBrand(brand.id, owner1);
      expect(deletedRight).toMatchObject({ cancelledChallenges: 0 });
      expect(deletedRight?.deletedAt).toBeTruthy();
      
      const foundAfter = await brands.getBrandById(brand.id);
      expect(foundAfter).toBeNull();
    });
  });

  describe("getActiveDistractorBrands", () => {
    it("excludes the target brand and caps out at 20 returned", async () => {
      const ownerId = await createUser("distractor-owner");
      
      for(let i=0; i<25; i++) {
        await brands.createBrand({
          owner_user_id: ownerId,
          name: `DBrand ${i}`,
          logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
        });
      }
      
      const distractor = await brands.createBrand({
        owner_user_id: ownerId,
        name: `Excluded brand`,
        logo_url: null, primary_color: null, secondary_color: null, tagline: null, brand_story: null, usp: null, product_image_keys: []
      });

      const result = await brands.getActiveDistractorBrands(distractor.id);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result.length).toBeGreaterThan(0);
      expect(result.find(r => r.id === distractor.id)).toBeUndefined();
    });
  });
});
