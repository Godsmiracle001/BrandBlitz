import { Router } from "express";
import { getHorizonServer, type NetworkName } from "@brandblitz/stellar";
import { pool } from "../db";
import { redis } from "../lib/redis";
import { config } from "../lib/config";
import { checkDependenciesHealth } from "../services/health-check";

const router = Router();

/**
 * GET /health — readiness probe. No authentication required (mounted before
 * the auth middleware in index.ts). Checks PostgreSQL, Redis, and Stellar
 * Horizon independently and reports per-dependency status; a single failure
 * degrades the overall response without hiding which dependency is down.
 */
router.get("/", async (_req, res) => {
  const health = await checkDependenciesHealth({
    checkDb: () => pool.query("SELECT 1"),
    checkRedis: () => redis.ping(),
    checkStellar: () => getHorizonServer(config.STELLAR_NETWORK as NetworkName).root(),
  });

  res.status(health.status === "ok" ? 200 : 503).json({
    ...health,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
