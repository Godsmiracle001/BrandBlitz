export type DependencyStatus = "ok" | "error";

export interface HealthCheckDeps {
  checkDb: () => Promise<unknown>;
  checkRedis: () => Promise<unknown>;
  checkStellar: () => Promise<unknown>;
}

export interface HealthCheckResult {
  status: "ok" | "degraded";
  db: DependencyStatus;
  redis: DependencyStatus;
  stellar: DependencyStatus;
}

const DEFAULT_TIMEOUT_MS = 3000;

async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<DependencyStatus> {
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("health check timed out")), timeoutMs)
      ),
    ]);
    return "ok";
  } catch {
    return "error";
  }
}

/**
 * Probes DB, Redis, and Stellar Horizon concurrently and reduces them to one
 * overall status. O(1): exactly 3 bounded checks run in parallel via
 * Promise.all, so wall time is bounded by max(timeoutMs), never their sum.
 * Dependencies are injected so callers (and tests) never need a live DB,
 * Redis, or network connection to exercise this logic.
 */
export async function checkDependenciesHealth(
  deps: HealthCheckDeps,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<HealthCheckResult> {
  const [db, redis, stellar] = await Promise.all([
    probe(deps.checkDb, timeoutMs),
    probe(deps.checkRedis, timeoutMs),
    probe(deps.checkStellar, timeoutMs),
  ]);

  return {
    status: db === "ok" && redis === "ok" && stellar === "ok" ? "ok" : "degraded",
    db,
    redis,
    stellar,
  };
}
