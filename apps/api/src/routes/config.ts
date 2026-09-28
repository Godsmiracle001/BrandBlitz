import { Router } from "express";
import { getPublicConfig, type PublicConfig } from "../db/queries/config";
import { redis } from "../lib/redis";

export const PUBLIC_CONFIG_CACHE_KEY = "config:public";
export const PUBLIC_CONFIG_CACHE_TTL_SECONDS = 60;

const router = Router();

/**
 * GET /config
 *
 * Public, read-through runtime configuration. Returns a flat object of
 * whitelisted app_config keys (see PUBLIC_CONFIG_KEYS) — never the raw
 * app_config table, so admin-only keys can't leak. The exact JSON envelope
 * is constructed before it reaches Redis so cached and uncached responses
 * are byte-for-byte the same shape.
 */
router.get("/", async (_req, res) => {
  res.set("Cache-Control", `public, max-age=${PUBLIC_CONFIG_CACHE_TTL_SECONDS}`);

  const cached = await redis.get(PUBLIC_CONFIG_CACHE_KEY);
  if (cached !== null) {
    res.set("X-Cache", "HIT");
    res.json(JSON.parse(cached));
    return;
  }

  const payload: PublicConfig = await getPublicConfig();
  await redis.set(
    PUBLIC_CONFIG_CACHE_KEY,
    JSON.stringify(payload),
    "EX",
    PUBLIC_CONFIG_CACHE_TTL_SECONDS,
  );

  res.set("X-Cache", "MISS");
  res.json(payload);
});

export default router;
