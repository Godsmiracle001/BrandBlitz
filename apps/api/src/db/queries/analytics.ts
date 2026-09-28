import { query } from "../index";

export interface BrandAnalytics {
  totalSessions: number;
  completedSessions: number;
  completionRate: number;
  questionAccuracy: Array<{
    round: number;
    questionType: string;
    questionText: string;
    totalAttempts: number;
    correctAttempts: number;
    accuracy: number;
  }>;
  costPerSession: Array<{
    date: string;
    totalCost: number;
    sessionCount: number;
    costPerSession: number;
  }>;
}

export async function getBrandAnalytics(
  brandId: string,
  from?: Date,
  to?: Date
): Promise<BrandAnalytics> {
  const challengeIds = await getChallengeIdsForBrand(brandId, from, to);

  if (challengeIds.length === 0) {
    return {
      totalSessions: 0,
      completedSessions: 0,
      completionRate: 0,
      questionAccuracy: [],
      costPerSession: [],
    };
  }

  const [sessionStats, questionAccuracy, costData] = await Promise.all([
    getSessionStats(challengeIds),
    getQuestionAccuracy(challengeIds),
    getCostPerSession(challengeIds, from, to),
  ]);

  return {
    totalSessions: sessionStats.totalSessions,
    completedSessions: sessionStats.completedSessions,
    completionRate:
      sessionStats.totalSessions > 0
        ? Math.round((sessionStats.completedSessions / sessionStats.totalSessions) * 100)
        : 0,
    questionAccuracy,
    costPerSession: costData,
  };
}

async function getChallengeIdsForBrand(brandId: string, from?: Date, to?: Date): Promise<string[]> {
  let sql = `SELECT id FROM challenges WHERE brand_id = $1 AND deleted_at IS NULL`;
  const params: unknown[] = [brandId];

  if (from) {
    params.push(from.toISOString());
    sql += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to.toISOString());
    sql += ` AND created_at <= $${params.length}`;
  }

  const result = await query<{ id: string }>(sql, params);
  return result.rows.map((r) => r.id);
}

async function getSessionStats(
  challengeIds: string[]
): Promise<{ totalSessions: number; completedSessions: number }> {
  const result = await query<{ total_sessions: number; completed_sessions: number }>(
    `SELECT
       COUNT(*)::int AS total_sessions,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_sessions
     FROM game_sessions
     WHERE challenge_id = ANY($1::uuid[])`,
    [challengeIds]
  );

  const row = result.rows[0];
  return {
    totalSessions: row?.total_sessions ?? 0,
    completedSessions: row?.completed_sessions ?? 0,
  };
}

async function getQuestionAccuracy(
  challengeIds: string[]
): Promise<BrandAnalytics["questionAccuracy"]> {
  if (challengeIds.length === 0) return [];

  const result = await query<{
    round: number;
    question_type: string;
    question_text: string;
    total_attempts: number;
    correct_attempts: number;
  }>(
    `SELECT
       cq.round,
       cq.question_type,
       cq.question_text,
       COUNT(srs.id)::int AS total_attempts,
       COUNT(srs.id) FILTER (WHERE srs.score > 0)::int AS correct_attempts
     FROM challenge_questions cq
     LEFT JOIN session_round_scores srs
       ON srs.round = cq.round
       AND srs.session_id IN (
         SELECT id FROM game_sessions
         WHERE challenge_id = ANY($1::uuid[])
           AND status = 'completed'
       )
     WHERE cq.challenge_id = ANY($1::uuid[])
     GROUP BY cq.round, cq.question_type, cq.question_text
     ORDER BY cq.round`,
    [challengeIds]
  );

  return result.rows.map((row) => ({
    round: row.round,
    questionType: row.question_type,
    questionText: row.question_text,
    totalAttempts: row.total_attempts,
    correctAttempts: row.correct_attempts,
    accuracy:
      row.total_attempts > 0 ? Math.round((row.correct_attempts / row.total_attempts) * 100) : 0,
  }));
}

async function getCostPerSession(
  challengeIds: string[],
  from?: Date,
  to?: Date
): Promise<BrandAnalytics["costPerSession"]> {
  const fromDate = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ?? new Date();

  const result = await query<{
    date: string;
    total_cost: number;
    session_count: number;
  }>(
    `SELECT
       DATE(gs.created_at) AS date,
       SUM(c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::float AS total_cost,
       COUNT(gs.id)::int AS session_count
     FROM game_sessions gs
     JOIN challenges c ON c.id = gs.challenge_id
     WHERE gs.challenge_id = ANY($1::uuid[])
       AND gs.created_at >= $2
       AND gs.created_at <= $3
     GROUP BY DATE(gs.created_at)
     ORDER BY date`,
    [challengeIds, fromDate.toISOString(), toDate.toISOString()]
  );

  return result.rows.map((row) => ({
    date: row.date,
    totalCost: Number(row.total_cost),
    sessionCount: row.session_count,
    costPerSession: row.session_count > 0 ? Number(row.total_cost) / row.session_count : 0,
  }));
}

// ── Anonymized platform benchmarks (issue #1042) ───────────────────────────
//
// Aggregates platform-wide medians for completion rate and cost-per-session,
// bucketed by brand size. Only aggregate medians are ever returned — no
// individual competitor brand rows leave this module.

/** Minimum challenges a brand needs before it contributes to the medians. */
export const BENCHMARK_MIN_CHALLENGES = 3;

export type BrandSizeBucket = "small" | "medium" | "large";

/**
 * Bucket brands by challenge count:
 *   small  — 1–4 challenges
 *   medium — 5–19 challenges
 *   large  — 20+ challenges
 *
 * Brands below `BENCHMARK_MIN_CHALLENGES` are excluded from benchmarks
 * entirely (too few challenges → statistical noise).
 */
export function brandSizeBucketFor(challengeCount: number): BrandSizeBucket {
  if (challengeCount >= 20) return "large";
  if (challengeCount >= 5) return "medium";
  return "small";
}

export const BUCKET_LABELS: Record<BrandSizeBucket, string> = {
  small: "small (1–4 challenges)",
  medium: "medium (5–19 challenges)",
  large: "large (20+ challenges)",
};

export interface PlatformBenchmarkMedians {
  sizeBucket: BrandSizeBucket;
  medianCompletionRate: number | null;
  medianCostPerSessionUsdc: number | null;
  sampleSize: number;
  minChallenges: number;
}

export interface BrandBenchmark {
  brand: {
    challengeCount: number;
    sizeBucket: BrandSizeBucket;
    qualified: boolean;
    completionRate: number | null;
    costPerSessionUsdc: number | null;
  };
  platform: PlatformBenchmarkMedians;
}

type BrandMetricRow = {
  challenge_count: number;
  total_sessions: number;
  completed_sessions: number;
  attributed_pool_usdc: string | number;
};

function round(value: number | null, decimals: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function metricsFromRow(row: BrandMetricRow | undefined): {
  completionRate: number | null;
  costPerSessionUsdc: number | null;
} {
  if (!row || row.total_sessions <= 0) {
    return { completionRate: null, costPerSessionUsdc: null };
  }
  return {
    completionRate: round((row.completed_sessions / row.total_sessions) * 100, 1),
    costPerSessionUsdc: round(Number(row.attributed_pool_usdc) / row.total_sessions, 4),
  };
}

/** Per-brand session metrics shared by the brand side and the platform side. */
const BRAND_METRICS_SELECT = `
  SELECT
    COUNT(DISTINCT c.id)::int AS challenge_count,
    COUNT(gs.id)::int AS total_sessions,
    COUNT(gs.id) FILTER (WHERE gs.status = 'completed')::int AS completed_sessions,
    COALESCE(
      SUM(c.pool_amount_stroops::numeric / 10000000) FILTER (WHERE gs.id IS NOT NULL),
      0
    ) AS attributed_pool_usdc
  FROM challenges c
  LEFT JOIN game_sessions gs ON gs.challenge_id = c.id
  WHERE c.brand_id = $1 AND c.deleted_at IS NULL
`;

/**
 * Anonymized platform medians for one size bucket.
 * Excludes brands with fewer than `BENCHMARK_MIN_CHALLENGES` challenges and
 * brands with zero sessions; returns aggregates only.
 */
export async function getPlatformBenchmarkMedians(
  sizeBucket: BrandSizeBucket
): Promise<PlatformBenchmarkMedians> {
  const result = await query<{
    sample_size: number;
    median_completion_rate: number | string | null;
    median_cost_per_session: number | string | null;
  }>(
    `WITH per_brand AS (
       SELECT
         b.id,
         COUNT(DISTINCT c.id)::int AS challenge_count,
         COUNT(gs.id)::int AS total_sessions,
         COUNT(gs.id) FILTER (WHERE gs.status = 'completed')::int AS completed_sessions,
         COALESCE(
           SUM(c.pool_amount_stroops::numeric / 10000000) FILTER (WHERE gs.id IS NOT NULL),
           0
         ) AS attributed_pool_usdc
       FROM brands b
       JOIN challenges c ON c.brand_id = b.id AND c.deleted_at IS NULL
       LEFT JOIN game_sessions gs ON gs.challenge_id = c.id
       WHERE b.deleted_at IS NULL
       GROUP BY b.id
       HAVING COUNT(DISTINCT c.id) >= $1
     ),
     metrics AS (
       SELECT
         CASE
           WHEN challenge_count >= 20 THEN 'large'
           WHEN challenge_count >= 5 THEN 'medium'
           ELSE 'small'
         END AS size_bucket,
         (completed_sessions::numeric / total_sessions) * 100 AS completion_rate,
         attributed_pool_usdc::numeric / total_sessions AS cost_per_session
       FROM per_brand
       WHERE total_sessions > 0
     )
     SELECT
       COUNT(*)::int AS sample_size,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY completion_rate) AS median_completion_rate,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_per_session) AS median_cost_per_session
     FROM metrics
     WHERE size_bucket = $2`,
    [BENCHMARK_MIN_CHALLENGES, sizeBucket]
  );

  const row = result.rows[0];
  return {
    sizeBucket,
    medianCompletionRate:
      row?.median_completion_rate != null ? round(Number(row.median_completion_rate), 1) : null,
    medianCostPerSessionUsdc:
      row?.median_cost_per_session != null ? round(Number(row.median_cost_per_session), 4) : null,
    sampleSize: row?.sample_size ?? 0,
    minChallenges: BENCHMARK_MIN_CHALLENGES,
  };
}

/**
 * A brand's own metrics alongside anonymized platform medians for its size
 * bucket. Never exposes individual competitor data — only aggregate medians.
 */
export async function getBrandBenchmark(brandId: string): Promise<BrandBenchmark> {
  const result = await query<BrandMetricRow>(BRAND_METRICS_SELECT, [brandId]);
  const row = result.rows[0];

  const challengeCount = row?.challenge_count ?? 0;
  const sizeBucket = brandSizeBucketFor(Math.max(challengeCount, 1));
  const qualified = challengeCount >= BENCHMARK_MIN_CHALLENGES;
  const metrics = metricsFromRow(row);

  const platform = qualified
    ? await getPlatformBenchmarkMedians(sizeBucket)
    : {
        sizeBucket,
        medianCompletionRate: null,
        medianCostPerSessionUsdc: null,
        sampleSize: 0,
        minChallenges: BENCHMARK_MIN_CHALLENGES,
      };

  return {
    brand: {
      challengeCount,
      sizeBucket,
      qualified,
      completionRate: metrics.completionRate,
      costPerSessionUsdc: metrics.costPerSessionUsdc,
    },
    platform,
  };
}
