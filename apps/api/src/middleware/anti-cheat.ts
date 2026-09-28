import type { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis";
import { createFraudFlag } from "../db/queries/fraud-flags";
import { getConfig } from "../db/queries/config";
import { getSession, claimSession } from "../db/queries/sessions";
import { logger } from "../lib/logger";
import { metrics } from "../lib/metrics";
import { computeFingerprint } from "../lib/fingerprint";
import { createError } from "./error";
import { normalizeClientIp } from "./rate-limit";
import { MAX_ROUND_SCORE, MAX_TOTAL_SCORE } from "../services/scoring";
import { config } from "../lib/config";
import { query } from "../db/index";

export const BOT_REACTION_THRESHOLD_MS = 80;
// Fallback defaults — override at runtime via PATCH /admin/config/anti_cheat.thresholds
export const MIN_HUMAN_REACTION_MS = 150;
export const MAX_HUMAN_REACTION_MS = 30_000;
export const MAX_CLOCK_SKEW_MS = 5000; // ±5 seconds tolerance for client timestamps

const THRESHOLDS_CACHE_KEY = "config:cache:anti_cheat.thresholds";
const THRESHOLDS_CONFIG_KEY = "anti_cheat.thresholds";
const CACHE_TTL_SECONDS = 5;

interface AntiCheatThresholds {
  min_human_reaction_ms: number;
  max_human_reaction_ms: number;
}

async function getThresholds(): Promise<AntiCheatThresholds> {
  try {
    const cached = await redis.get(THRESHOLDS_CACHE_KEY);
    if (cached) return JSON.parse(cached) as AntiCheatThresholds;

    const config = await getConfig(THRESHOLDS_CONFIG_KEY);
    const thresholds: AntiCheatThresholds = {
      min_human_reaction_ms:
        (config?.min_human_reaction_ms as number) ?? MIN_HUMAN_REACTION_MS,
      max_human_reaction_ms:
        (config?.max_human_reaction_ms as number) ?? MAX_HUMAN_REACTION_MS,
    };

    await redis.set(THRESHOLDS_CACHE_KEY, JSON.stringify(thresholds), "EX", CACHE_TTL_SECONDS);
    return thresholds;
  } catch {
    return {
      min_human_reaction_ms: MIN_HUMAN_REACTION_MS,
      max_human_reaction_ms: MAX_HUMAN_REACTION_MS,
    };
  }
}

async function resolveSessionId(req: Request): Promise<string | undefined> {
  const existingSessionId = (req as any).sessionId as string | undefined;
  if (existingSessionId) return existingSessionId;

  const challengeId = req.params.challengeId;
  const userId = req.user?.sub;
  if (!challengeId || !userId) return undefined;

  const session = await getSession(userId, challengeId);
  return session?.id;
}

async function recordFraudFlag(
  req: Request,
  flagType: string,
  details?: Record<string, unknown>
): Promise<void> {
  const userId = req.user?.sub;
  if (!userId) return;

  const sessionId = await resolveSessionId(req);
  if (!sessionId) return;

  await createFraudFlag({ sessionId, userId, flagType, details });
  // Fraud review queries rely on idx_game_sessions_flagged for flagged-session scans.

  const severity = (details?.severity as string) || "warning";
  metrics.inc("antiCheat.flags_total", { severity, type: flagType });
}

async function recordFraudFlagBestEffort(
  req: Request,
  flagType: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await recordFraudFlag(req, flagType, details);
  } catch (error) {
    logger.warn("Failed to record anti-cheat fraud flag; continuing request handling", {
      flagType,
      userId: req.user?.sub,
      error: (error as Error).message,
    });
  }
}

/**
 * Anti-cheat Layer 4 — client clock skew detection.
 * Validates client-supplied timestamps are within ±5 seconds of server time.
 * Flags requests with excessive clock skew as potential manipulation attempts.
 */
export async function detectClockSkew(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const { clientTimestamp } = req.body as { clientTimestamp?: number };

  if (clientTimestamp === undefined) {
    next();
    return;
  }

  if (!Number.isFinite(clientTimestamp) || clientTimestamp <= 0) {
    await recordFraudFlagBestEffort(req, "invalid_client_timestamp", {
      clientTimestamp,
      severity: "warning",
    });
    throw createError("Invalid client timestamp", 400, "INVALID_TIMESTAMP");
  }

  const serverTime = Date.now();
  const clockSkewMs = Math.abs(serverTime - clientTimestamp);

  if (clockSkewMs > MAX_CLOCK_SKEW_MS) {
    await recordFraudFlagBestEffort(req, "clock_skew", {
      clientTimestamp,
      serverTime,
      clockSkewMs,
      severity: "warning",
    });
    throw createError("Client clock skew too large", 400, "CLOCK_SKEW");
  }

  next();
}

/**
 * Anti-cheat Layer 3 — server-side timing validation.
 * Validates that answer submission timing falls within human range.
 * Thresholds are read from app_config (5s Redis cache) with fallback to defaults.
 */
export async function validateReactionTime(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const { reactionTimeMs } = req.body as { reactionTimeMs?: number };

  if (reactionTimeMs === undefined) {
    next();
    return;
  }

  if (reactionTimeMs < BOT_REACTION_THRESHOLD_MS) {
    await recordFraudFlagBestEffort(req, "reaction_time_bot_threshold", {
      reactionTimeMs,
      severity: "critical",
    });
    throw createError("Reaction time impossible for humans", 403, "REACTION_IMPOSSIBLE");
  }

  const thresholds = await getThresholds();

  if (reactionTimeMs < thresholds.min_human_reaction_ms) {
    await recordFraudFlagBestEffort(req, "reaction_time_below_minimum", {
      reactionTimeMs,
      severity: "warning",
    });
  }

  if (reactionTimeMs > thresholds.max_human_reaction_ms) {
    await recordFraudFlagBestEffort(req, "reaction_time_above_maximum", {
      reactionTimeMs,
      severity: "info",
    });
  }

  next();
}

/**
 * Enforces: 1 competitive session per account per challenge.
 * Uses the DB UNIQUE constraint atomically — no check-then-act race.
 * If the existing session is abandoned (explicit quit or timeout), it is
 * atomically replaced so the player can start fresh without a UNIQUE conflict.
 */
export async function enforceOneSessionPerChallenge(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.user!.sub;
  const { challengeId } = req.params;
  const deviceId =
    (req.headers["x-device-id"] as string | undefined) ??
    (req.headers["x-visitor-id"] as string | undefined);
  const isPractice = req.body.isPractice === true;

  const session = await claimSession({
    userId,
    challengeId,
    deviceId,
    isPractice,
  });

  if (session) {
    (req as any).session = session;
    next();
    return;
  }

  // Session already exists — fetch to check its status.
  const existing = await getSession(userId, challengeId);
  if (!existing) {
    throw createError("Session not found", 404);
  }

  if (existing.status === "abandoned") {
    // Atomically delete the abandoned session and insert a fresh one.
    // The CTE guards against the race where two concurrent requests both
    // see the abandoned row: only the request whose DELETE matches (rowCount
    // = 1) proceeds to INSERT; the other falls through to the refetch below.
    const result = await query<import("../db/queries/sessions").GameSession>(
      `WITH del AS (
         DELETE FROM game_sessions
         WHERE user_id = $1 AND challenge_id = $2 AND status = 'abandoned'
         RETURNING id
       )
       INSERT INTO game_sessions (user_id, challenge_id, device_id, is_practice)
       SELECT $1, $2, $3, $4
       WHERE EXISTS (SELECT 1 FROM del)
       ON CONFLICT (user_id, challenge_id) DO NOTHING
       RETURNING *`,
      [userId, challengeId, deviceId ?? null, isPractice]
    );
    const fresh = result.rows[0] ?? null;
    if (!fresh) {
      // Concurrent request won the race and already created a new session.
      const refetched = await getSession(userId, challengeId);
      if (!refetched) throw createError("Session not found", 404);
      (req as any).session = refetched;
      next();
      return;
    }
    (req as any).session = fresh;
    next();
    return;
  }

  (req as any).session = existing;
  next();
}

/**
 * Anti-cheat Layer 2 — stable device fingerprint check.
 * Derives a server-side fingerprint from (visitorId | deviceId) + IP /24 + UA hash.
 * Rejects sessions when the fingerprint is shared by >2 accounts in 24 h.
 */
export async function validateDeviceFingerprint(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const rawVisitorId = req.headers["x-visitor-id"];
  const rawDeviceId = req.headers["x-device-id"];

  const visitorId = Array.isArray(rawVisitorId) ? rawVisitorId[0] : rawVisitorId;
  const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;

  if (!visitorId && !deviceId) {
    throw createError("Missing X-Device-Id header", 400, "MISSING_DEVICE_ID");
  }

  const userId = req.user?.sub;
  if (!userId) {
    next();
    return;
  }

  try {
    const fingerprint = computeFingerprint({
      visitorId,
      deviceId,
      ip: normalizeClientIp(req.ip),
      userAgent: req.headers["user-agent"],
    });

    const fpKey = `fp:${fingerprint}:accounts`;
    await redis.sadd(fpKey, userId);
    await redis.expire(fpKey, 86400); // 24 h window
    const count = await redis.scard(fpKey);

    if (count >= 3) {
      metrics.inc("antiCheat.fingerprint_collision_total", {
        fingerprint: fingerprint.slice(0, 8),
      });
      await recordFraudFlagBestEffort(req, "multi_account_fingerprint", {
        fingerprint: fingerprint.slice(0, 8),
        accountCount: count,
        windowSeconds: 86400,
        severity: "critical",
      });
      throw createError(
        "Session rejected due to fingerprint collision",
        403,
        "FINGERPRINT_COLLISION"
      );
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) {
      throw error;
    }
    logger.warn("Redis unavailable during device fingerprint validation; failing open", {
      userId,
      error: (error as Error).message,
    });
  }

  next();
}

/**
 * Anti-cheat Layer 4 — score bounds validation.
 * Flags sessions where a round score exceeds the per-round maximum.
 * Called after server-side score computation, before persisting.
 */
export async function validateRoundScore(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const { roundScore } = req.body as { roundScore?: number };

  if (roundScore === undefined) {
    next();
    return;
  }

  if (!Number.isFinite(roundScore) || roundScore < 0 || roundScore > MAX_ROUND_SCORE) {
    await recordFraudFlagBestEffort(req, "round_score_out_of_range", {
      roundScore,
      maxAllowed: MAX_ROUND_SCORE,
      severity: "critical",
    });
    throw createError(
      `Round score ${roundScore} exceeds per-round maximum of ${MAX_ROUND_SCORE}`,
      422,
      "ROUND_SCORE_OUT_OF_RANGE"
    );
  }

  next();
}

// ─── Session-start brute-force lockout (issue #509) ──────────────────────────

const SESSION_START_LOCKOUT_CONFIG_KEY = "session_start_lockout";

interface SessionStartLockoutConfig {
  threshold: number;
  windowSeconds: number;
}

function sessionStartLockoutKey(userId: string): string {
  return `lockout:session_start:${userId}`;
}

/**
 * Resolve the lockout threshold/window, preferring the runtime-tunable
 * app_config key `session_start_lockout` and falling back to env-configured
 * defaults so ops can adjust limits without a deploy.
 */
async function getSessionStartLockoutConfig(): Promise<SessionStartLockoutConfig> {
  const fallback: SessionStartLockoutConfig = {
    threshold: config.SESSION_START_LOCKOUT_THRESHOLD,
    windowSeconds: config.SESSION_START_LOCKOUT_WINDOW_SECONDS,
  };
  try {
    const cfg = await getConfig(SESSION_START_LOCKOUT_CONFIG_KEY);
    const threshold = Number(cfg?.threshold);
    const windowSeconds = Number(cfg?.window_seconds);
    return {
      threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : fallback.threshold,
      windowSeconds:
        Number.isFinite(windowSeconds) && windowSeconds > 0
          ? windowSeconds
          : fallback.windowSeconds,
    };
  } catch {
    return fallback;
  }
}

async function writeSessionStartLockoutAudit(
  userId: string,
  cfg: SessionStartLockoutConfig
): Promise<void> {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, before, after)
     VALUES ($1, 'session_start_lockout', 'user', $2, $3, $4)`,
    [userId, userId, null, { threshold: cfg.threshold, windowSeconds: cfg.windowSeconds }]
  );
}

/**
 * Brute-force guard for POST /sessions/:challengeId/start.
 *
 * Maintains a rolling failure counter in Redis per user
 * (`lockout:session_start:{userId}`). Once the configured threshold of failed
 * start attempts is reached within the window, further start requests are
 * rejected with HTTP 429 + Retry-After until the key's TTL expires. Successful
 * starts never increment or consume the counter. Fails open if Redis is down.
 */
export async function requireSessionStartAllowed(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.user?.sub;
  if (!userId) {
    next();
    return;
  }

  const key = sessionStartLockoutKey(userId);
  const cfg = await getSessionStartLockoutConfig();

  let count = 0;
  let ttl = cfg.windowSeconds;
  try {
    const [raw, currentTtl] = await Promise.all([redis.get(key), redis.ttl(key)]);
    count = raw ? parseInt(raw, 10) : 0;
    if (typeof currentTtl === "number" && currentTtl > 0) ttl = currentTtl;
  } catch (error) {
    // Redis outage must never block legitimate logins — fail open.
    logger.warn("Redis unavailable during session-start lockout check; failing open", {
      userId,
      error: (error as Error).message,
    });
    next();
    return;
  }

  if (count >= cfg.threshold) {
    res.setHeader("Retry-After", String(ttl));
    metrics.inc("antiCheat.session_start_lockout_total", {});
    throw createError(
      "Too many failed session start attempts. Please try again later.",
      429,
      "SESSION_START_LOCKED"
    );
  }

  // Increment the failure counter only when the start attempt actually fails.
  // Registered before next() so the listener observes the final status code.
  res.on("finish", () => {
    if (res.statusCode < 400) return;
    void (async () => {
      try {
        const updated = await redis.incr(key);
        if (updated === 1) {
          await redis.expire(key, cfg.windowSeconds);
        }
        if (updated === cfg.threshold) {
          await writeSessionStartLockoutAudit(userId, cfg).catch((error) => {
            logger.warn("Failed to write session_start_lockout audit event", {
              userId,
              error: (error as Error).message,
            });
          });
        }
      } catch (error) {
        logger.warn("Failed to record session-start failure", {
          userId,
          error: (error as Error).message,
        });
      }
    })();
  });

  next();
}

/**
 * Validate that a total session score is within bounds.
 * Returns a structured error if the value would exceed [0, MAX_TOTAL_SCORE].
 * Intended for use after score computation and before persistence.
 */
export function assertValidTotalScore(totalScore: number): void {
  if (!Number.isFinite(totalScore) || totalScore < 0 || totalScore > MAX_TOTAL_SCORE) {
    throw createError(
      `Total score ${totalScore} is outside valid range [0, ${MAX_TOTAL_SCORE}]`,
      422,
      "TOTAL_SCORE_OUT_OF_RANGE"
    );
  }
}
