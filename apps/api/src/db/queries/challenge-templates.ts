import { query } from "../index";
import { usdcToStroops } from "../../lib/usdc";

export type ChallengeTemplateStatus = "active" | "paused" | "deleted";
export type RecurrenceRule = "daily" | "weekly" | "biweekly" | "monthly" | "custom";

export interface ChallengeTemplate {
  id: string;
  brand_id: string;
  pool_amount_usdc: string;
  pool_amount_stroops: string;
  max_players: number | null;
  duration_hours: number;
  recurrence_rule: RecurrenceRule;
  recurrence_cron: string | null;
  recurrence_timezone: string;
  status: ChallengeTemplateStatus;
  last_spawned_period: string | null;
  last_spawned_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: Record<string, unknown>): ChallengeTemplate {
  return {
    id: String(row.id),
    brand_id: String(row.brand_id),
    pool_amount_usdc: String(row.pool_amount_usdc),
    pool_amount_stroops: String(row.pool_amount_stroops),
    max_players:
      row.max_players !== null && row.max_players !== undefined
        ? Number(row.max_players)
        : null,
    duration_hours: Number(row.duration_hours),
    recurrence_rule: row.recurrence_rule as RecurrenceRule,
    recurrence_cron:
      row.recurrence_cron !== null && row.recurrence_cron !== undefined
        ? String(row.recurrence_cron)
        : null,
    recurrence_timezone: String(row.recurrence_timezone ?? "UTC"),
    status: row.status as ChallengeTemplateStatus,
    last_spawned_period:
      row.last_spawned_period !== null && row.last_spawned_period !== undefined
        ? String(row.last_spawned_period)
        : null,
    last_spawned_at:
      row.last_spawned_at !== null && row.last_spawned_at !== undefined
        ? String(row.last_spawned_at)
        : null,
    deleted_at:
      row.deleted_at !== null && row.deleted_at !== undefined
        ? String(row.deleted_at)
        : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function createChallengeTemplate(data: {
  brandId: string;
  poolAmountUsdc: string;
  maxPlayers?: number;
  durationHours: number;
  recurrenceRule: RecurrenceRule;
  recurrenceCron?: string;
  recurrenceTimezone?: string;
}): Promise<ChallengeTemplate> {
  const result = await query<ChallengeTemplate>(
    `INSERT INTO challenge_templates
       (brand_id, pool_amount_usdc, max_players, duration_hours,
        recurrence_rule, recurrence_cron, recurrence_timezone)
     VALUES ($1, $2::numeric(20,7), $3, $4, $5, $6, COALESCE($7, 'UTC'))
     RETURNING id, brand_id,
       pool_amount_usdc::text, pool_amount_stroops::text,
       max_players, duration_hours,
       recurrence_rule, recurrence_cron, recurrence_timezone,
       status, last_spawned_period, last_spawned_at,
       deleted_at, created_at, updated_at`,
    [
      data.brandId,
      data.poolAmountUsdc,
      data.maxPlayers ?? null,
      data.durationHours,
      data.recurrenceRule,
      data.recurrenceRule === "custom" ? data.recurrenceCron ?? null : null,
      data.recurrenceTimezone ?? null,
    ]
  );
  return rowToTemplate(result.rows[0]);
}

export async function getChallengeTemplateById(
  id: string
): Promise<ChallengeTemplate | null> {
  const result = await query<ChallengeTemplate>(
    `SELECT id, brand_id,
       pool_amount_usdc::text, pool_amount_stroops::text,
       max_players, duration_hours,
       recurrence_rule, recurrence_cron, recurrence_timezone,
       status, last_spawned_period, last_spawned_at,
       deleted_at, created_at, updated_at
     FROM challenge_templates
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
}

export async function getChallengeTemplatesByBrandId(
  brandId: string,
  opts?: { includeDeleted?: boolean }
): Promise<ChallengeTemplate[]> {
  const includeDeleted = opts?.includeDeleted ?? false;
  const result = await query<ChallengeTemplate>(
    `SELECT id, brand_id,
       pool_amount_usdc::text, pool_amount_stroops::text,
       max_players, duration_hours,
       recurrence_rule, recurrence_cron, recurrence_timezone,
       status, last_spawned_period, last_spawned_at,
       deleted_at, created_at, updated_at
     FROM challenge_templates
     WHERE brand_id = $1 ${includeDeleted ? "" : "AND deleted_at IS NULL"}
     ORDER BY created_at DESC`,
    [brandId]
  );
  return result.rows.map(rowToTemplate);
}

export async function listActiveChallengeTemplates(): Promise<ChallengeTemplate[]> {
  const result = await query<ChallengeTemplate>(
    `SELECT id, brand_id,
       pool_amount_usdc::text, pool_amount_stroops::text,
       max_players, duration_hours,
       recurrence_rule, recurrence_cron, recurrence_timezone,
       status, last_spawned_period, last_spawned_at,
       deleted_at, created_at, updated_at
     FROM challenge_templates
     WHERE status = 'active' AND deleted_at IS NULL`,
    []
  );
  return result.rows.map(rowToTemplate);
}

export async function pauseChallengeTemplate(id: string): Promise<ChallengeTemplate | null> {
  const result = await query<ChallengeTemplate>(
    `UPDATE challenge_templates
     SET status = 'paused', updated_at = NOW()
     WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
     RETURNING id, brand_id,
       pool_amount_usdc::text, pool_amount_stroops::text,
       max_players, duration_hours,
       recurrence_rule, recurrence_cron, recurrence_timezone,
       status, last_spawned_period, last_spawned_at,
       deleted_at, created_at, updated_at`,
    [id]
  );
  return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
}

export async function resumeChallengeTemplate(id: string): Promise<ChallengeTemplate | null> {
  const result = await query<ChallengeTemplate>(
    `UPDATE challenge_templates
     SET status = 'active', updated_at = NOW()
     WHERE id = $1 AND status = 'paused' AND deleted_at IS NULL
     RETURNING id, brand_id,
       pool_amount_usdc::text, pool_amount_stroops::text,
       max_players, duration_hours,
       recurrence_rule, recurrence_cron, recurrence_timezone,
       status, last_spawned_period, last_spawned_at,
       deleted_at, created_at, updated_at`,
    [id]
  );
  return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
}

export async function softDeleteChallengeTemplate(id: string): Promise<void> {
  await query(
    `UPDATE challenge_templates
     SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
}

export async function markTemplateSpawned(
  id: string,
  period: string
): Promise<void> {
  await query(
    `UPDATE challenge_templates
     SET last_spawned_period = $1, last_spawned_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [period, id]
  );
}

export async function getUpcomingChallengesFromTemplatesByBrandId(
  brandId: string,
  limit = 5
): Promise<
  Array<{
    template_id: string;
    recurrence_rule: RecurrenceRule;
    next_starts_at: string;
    next_ends_at: string;
    pool_amount_usdc: string;
    duration_hours: number;
  }>
> {
  const result = await query<{
    template_id: string;
    recurrence_rule: RecurrenceRule;
    next_starts_at: string;
    next_ends_at: string;
    pool_amount_usdc: string;
    duration_hours: number;
  }>(
    `SELECT
       t.id AS template_id,
       t.recurrence_rule,
       CASE
         WHEN t.recurrence_rule = 'daily'
           THEN DATE_TRUNC('day', NOW()) + INTERVAL '1 day'
         WHEN t.recurrence_rule = 'weekly'
           THEN DATE_TRUNC('week', NOW()) + INTERVAL '1 week'
         WHEN t.recurrence_rule = 'biweekly'
           THEN DATE_TRUNC('week', NOW()) + INTERVAL '2 weeks'
         WHEN t.recurrence_rule = 'monthly'
           THEN DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
         ELSE NOW() + INTERVAL '1 day'
       END AS next_starts_at,
       (CASE
         WHEN t.recurrence_rule = 'daily'
           THEN DATE_TRUNC('day', NOW()) + INTERVAL '1 day'
         WHEN t.recurrence_rule = 'weekly'
           THEN DATE_TRUNC('week', NOW()) + INTERVAL '1 week'
         WHEN t.recurrence_rule = 'biweekly'
           THEN DATE_TRUNC('week', NOW()) + INTERVAL '2 weeks'
         WHEN t.recurrence_rule = 'monthly'
           THEN DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
         ELSE NOW() + INTERVAL '1 day'
       END) + (t.duration_hours || 0) * INTERVAL '1 hour' AS next_ends_at,
       t.pool_amount_usdc::text,
       t.duration_hours
     FROM challenge_templates t
     WHERE t.brand_id = $1
       AND t.status = 'active'
       AND t.deleted_at IS NULL
     ORDER BY next_starts_at ASC
     LIMIT $2`,
    [brandId, limit]
  );
  return result.rows.map((r) => ({
    template_id: String(r.template_id),
    recurrence_rule: r.recurrence_rule,
    next_starts_at: String(r.next_starts_at),
    next_ends_at: String(r.next_ends_at),
    pool_amount_usdc: String(r.pool_amount_usdc),
    duration_hours: Number(r.duration_hours),
  }));
}
