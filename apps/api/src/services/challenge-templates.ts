import { randomUUID } from "node:crypto";
import { getBrandById, getActiveDistractorBrands } from "../db/queries/brands";
import {
  createChallenge,
  insertChallengeQuestions,
  type Challenge,
} from "../db/queries/challenges";
import {
  getChallengeTemplateById,
  listActiveChallengeTemplates,
  markTemplateSpawned,
  type ChallengeTemplate,
} from "../db/queries/challenge-templates";
import { generateChallengeQuestions } from "./questions";
import { generateDepositMemo } from "@brandblitz/stellar";
import { logger } from "../lib/logger";
import { query, pool } from "../db";

function periodKeyForRule(
  rule: ChallengeTemplate["recurrence_rule"],
  from: Date = new Date()
): string {
  const year = from.getUTCFullYear();
  const month = String(from.getUTCMonth() + 1).padStart(2, "0");
  switch (rule) {
    case "daily": {
      const day = String(from.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    case "weekly": {
      const wk = isoWeek(from);
      return `${year}-W${wk}`;
    }
    case "biweekly": {
      const wk = isoWeek(from);
      const period = Math.ceil(wk / 2);
      return `${year}-B${period}`;
    }
    case "monthly":
      return `${year}-${month}`;
    case "custom":
    default: {
      const day = String(from.getUTCDate()).padStart(2, "0");
      const hh = String(from.getUTCHours()).padStart(2, "0");
      const mm = String(from.getUTCMinutes()).padStart(2, "0");
      return `${year}-${month}-${day}T${hh}${mm}`;
    }
  }
}

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return String(weekNo).padStart(2, "0");
}

export function computeNextPeriodForTemplate(
  template: ChallengeTemplate,
  now: Date = new Date()
): { periodKey: string; startsAt: Date; endsAt: Date } {
  const startsAt = computeNextStartDate(template, now);
  const endsAt = new Date(startsAt.getTime() + template.duration_hours * 60 * 60 * 1000);
  const periodKey = periodKeyForRule(template.recurrence_rule, startsAt);
  return { periodKey, startsAt, endsAt };
}

function computeNextStartDate(template: ChallengeTemplate, now: Date): Date {
  switch (template.recurrence_rule) {
    case "daily": {
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    case "weekly": {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dayOfWeek = d.getUTCDay(); // 0=Sun
      const daysUntilMon = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      d.setUTCDate(d.getUTCDate() + daysUntilMon);
      return d;
    }
    case "biweekly": {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dayOfWeek = d.getUTCDay();
      const daysUntilMon = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      d.setUTCDate(d.getUTCDate() + daysUntilMon + 7);
      return d;
    }
    case "monthly": {
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    }
    case "custom":
    default: {
      const next = new Date(now.getTime());
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
  }
}

export interface SpawnedChallengeFromTemplate {
  challenge: Challenge;
  depositMemo: string;
  periodKey: string;
}

export async function spawnChallengeFromTemplate(
  templateId: string,
  opts?: { forcePeriod?: string; startsAtOverride?: Date }
): Promise<SpawnedChallengeFromTemplate | null> {
  const template = await getChallengeTemplateById(templateId);
  if (!template || template.status === "deleted" || template.deleted_at) {
    return null;
  }

  const brand = await getBrandById(template.brand_id);
  if (!brand) {
    logger.warn("Skipping spawn: brand not found for template", {
      templateId,
      brandId: template.brand_id,
    });
    return null;
  }

  const next = computeNextPeriodForTemplate(template);
  const periodKey = opts?.forcePeriod ?? next.periodKey;

  if (template.last_spawned_period === periodKey && !opts?.forcePeriod) {
    logger.debug("Skipping spawn: template already spawned for period", {
      templateId,
      periodKey,
    });
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query<{ id: string }>(
      `SELECT id FROM challenge_templates WHERE id = $1 FOR UPDATE`,
      [templateId]
    );
    if (lock.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const already = await client.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
       FROM challenges
       WHERE template_id = $1 AND spawned_period = $2`,
      [templateId, periodKey]
    );
    if (Number(already.rows[0]?.count ?? 0) > 0) {
      await markTemplateSpawned(templateId, periodKey);
      await client.query("COMMIT");
      logger.debug("Skipping spawn: challenge already exists for period", {
        templateId,
        periodKey,
      });
      return null;
    }

    const startsAt = (opts?.startsAtOverride ?? next.startsAt).toISOString();
    const endsAt = new Date(
      new Date(startsAt).getTime() + template.duration_hours * 60 * 60 * 1000
    ).toISOString();

    const challengeId = randomUUID();
    const depositMemo = generateDepositMemo();

    const insertResult = await client.query<Challenge>(
      `INSERT INTO challenges
         (brand_id, challenge_id, deposit_memo, pool_amount_stroops,
          max_players, starts_at, ends_at, template_id, spawned_period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *, (pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc`,
      [
        template.brand_id,
        challengeId,
        depositMemo,
        template.pool_amount_stroops,
        template.max_players,
        startsAt,
        endsAt,
        templateId,
        periodKey,
      ]
    );
    const challenge = insertResult.rows[0];

    const distractorBrands = await getActiveDistractorBrands(template.brand_id);
    if (distractorBrands.length === 0) {
      logger.warn("Distractor pool empty for template spawned challenge", {
        templateId,
        challengeId: challenge.id,
      });
    }

    const questions = generateChallengeQuestions(challenge.id, brand, distractorBrands);
    for (const q of questions) {
      await client.query(
        `INSERT INTO challenge_questions
           (challenge_id, round, question_type, prompt_type, question_text,
            correct_answer, option_a, option_b, option_c, option_d, correct_option)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          q.challenge_id,
          q.round,
          q.question_type,
          q.prompt_type,
          q.question_text,
          q.correct_answer,
          q.option_a,
          q.option_b,
          q.option_c,
          q.option_d,
          q.correct_option,
        ]
      );
    }

    await client.query(
      `UPDATE challenge_templates
       SET last_spawned_period = $1, last_spawned_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [periodKey, templateId]
    );

    await client.query("COMMIT");
    logger.info("Spawned challenge from template", {
      templateId,
      challengeId: challenge.id,
      periodKey,
      brandId: template.brand_id,
    });

    return { challenge, depositMemo, periodKey };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function spawnDueChallengesFromAllTemplates(): Promise<{
  spawned: number;
  skipped: number;
  errors: number;
  errorsList: Array<{ templateId: string; error: string }>;
}> {
  const templates = await listActiveChallengeTemplates();
  let spawned = 0;
  let skipped = 0;
  let errors = 0;
  const errorsList: Array<{ templateId: string; error: string }> = [];

  for (const template of templates) {
    try {
      const result = await spawnChallengeFromTemplate(template.id);
      if (result) {
        spawned += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      errors += 1;
      errorsList.push({
        templateId: template.id,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.error("Failed to spawn challenge from template", {
        templateId: template.id,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  return { spawned, skipped, errors, errorsList };
}
