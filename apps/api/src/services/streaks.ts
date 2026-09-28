import { metrics } from "../lib/metrics";
import { query } from "../db";
import { logger } from "../lib/logger";
import {
  getUserStreak,
  repairUserStreak,
  setUserStreak,
  type StreakState,
} from "../db/queries/users";

const STREAK_MILESTONES = [3, 7, 14, 30] as const;
const NOTIFICATION_MILESTONES = new Set([7, 30, 100]);
const STREAK_FREEZE_DAYS = 1;

export interface StreakResponse {
  streak: number;
  lastPlayDay: string | null;
  repairAvailable: boolean;
  nextMilestone: number;
  progress: number;
  milestoneJustHit: boolean;
}

export interface StreakDetailResponse {
  current_streak: number;
  longest_streak: number;
  last_activity_at: string | null;
  is_at_risk: boolean;
  repair_deadline_at: string | null;
  next_milestone: {
    days_required: number;
    reward_badge_id: string;
  };
  streak_frozen: boolean;
}

export async function updateStreak(userId: string, now = new Date()): Promise<StreakState> {
  const current = await getUserStreak(userId);
  if (!current) throw new Error("User not found");

  const today = toUtcDay(now);
  const lastPlayDay = normalizeDay(current.last_play_day);

  if (lastPlayDay === today) {
    return current;
  }

  const newStreak = lastPlayDay && dayDiff(lastPlayDay, today) === 1 ? current.streak + 1 : 1;

  const updated = await setUserStreak({
    userId,
    streak: newStreak,
    lastPlayDay: today,
    repairAvailable: newStreak >= 3,
  });

  if (STREAK_MILESTONES.includes(newStreak as any)) {
    metrics.inc("streaks.milestones_reached_total", { milestone: String(newStreak) });
  }

  if (NOTIFICATION_MILESTONES.has(newStreak)) {
    await insertStreakMilestoneNotification(userId, newStreak);
  }

  return updated;
}

export async function getStreak(userId: string, now = new Date()): Promise<StreakResponse> {
  const current = await getUserStreak(userId);
  if (!current) throw new Error("User not found");
  return formatStreak(current, now);
}

export async function getStreakDetail(userId: string, now = new Date()): Promise<StreakDetailResponse> {
  const current = await getUserStreak(userId);
  if (!current) throw new Error("User not found");

  const normalizedStreak = typeof current.streak === "number" ? current.streak : 0;
  const lastPlayDay = normalizeDay(current.last_play_day);
  const today = toUtcDay(now);

  const nextMilestoneValue =
    STREAK_MILESTONES.find((m) => m > normalizedStreak) ??
    STREAK_MILESTONES[STREAK_MILESTONES.length - 1];

  const isAtRisk = lastPlayDay && dayDiff(lastPlayDay, today) === 1;
  let repairDeadlineAt: string | null = null;

  if (isAtRisk && lastPlayDay) {
    const deadline = new Date(lastPlayDay);
    deadline.setDate(deadline.getDate() + 2);
    repairDeadlineAt = deadline.toISOString();
  }

  const badgeMap: Record<number, string> = {
    3: "streak_3_days",
    7: "streak_7_days",
    14: "streak_14_days",
    30: "streak_30_days",
  };

  return {
    current_streak: normalizedStreak,
    longest_streak: normalizedStreak,
    last_activity_at: lastPlayDay ? new Date(`${lastPlayDay}T00:00:00.000Z`).toISOString() : null,
    is_at_risk: !!isAtRisk,
    repair_deadline_at: repairDeadlineAt,
    next_milestone: {
      days_required: nextMilestoneValue,
      reward_badge_id: badgeMap[nextMilestoneValue] || "streak_badge",
    },
    streak_frozen: false,
  };
}

export async function repairStreak(
  userId: string,
  now = new Date()
): Promise<StreakResponse | null> {
  const repaired = await repairUserStreak(userId, toUtcDay(now));
  return repaired ? formatStreak(repaired, now) : null;
}

function formatStreak(streak: StreakState, now: Date): StreakResponse {
  const normalizedStreak = typeof streak.streak === "number" ? streak.streak : 0;
  const lastPlayDay = normalizeDay(streak.last_play_day);
  const nextMilestone =
    STREAK_MILESTONES.find((m) => m > normalizedStreak) ??
    STREAK_MILESTONES[STREAK_MILESTONES.length - 1];
  return {
    streak: normalizedStreak,
    lastPlayDay,
    repairAvailable: streak.streak_repair_available,
    nextMilestone,
    progress: Math.min(1, normalizedStreak / Math.max(1, nextMilestone)),
    milestoneJustHit:
      STREAK_MILESTONES.includes(normalizedStreak as any) && lastPlayDay === toUtcDay(now),
  };
}

function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeDay(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / 86_400_000);
}

async function insertStreakMilestoneNotification(userId: string, milestone: number): Promise<void> {
  try {
    await query(
      `INSERT INTO notifications (user_id, type, payload)
       VALUES ($1, 'streak_milestone', $2::jsonb)`,
      [userId, JSON.stringify({ milestone })],
    );
  } catch (err) {
    logger.warn("Failed to insert streak milestone notification", { userId, milestone, err });
  }
}

export interface ActivityRecord {
  date: string;
  session_count: number;
}

export async function getUserActivity(userId: string, now = new Date()): Promise<ActivityRecord[]> {
  const endDate = toUtcDay(now);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 364);
  const startDateStr = toUtcDay(startDate);

  const result = await query<ActivityRecord>(
    `SELECT
       DATE(gs.completed_at) AS date,
       COUNT(*)::int AS session_count
     FROM game_sessions gs
     WHERE gs.user_id = $1
       AND gs.status = 'completed'
       AND DATE(gs.completed_at) >= $2::date
       AND DATE(gs.completed_at) <= $3::date
     GROUP BY DATE(gs.completed_at)
     ORDER BY date`,
    [userId, startDateStr, endDate]
  );

  const activityMap = new Map<string, number>();
  result.rows.forEach((row: ActivityRecord) => {
    activityMap.set(row.date, row.session_count);
  });

  const activity: ActivityRecord[] = [];
  const current = new Date(startDateStr);
  const end = new Date(endDate);
  end.setDate(end.getDate() + 1);

  while (current < end) {
    const dateStr = toUtcDay(current);
    activity.push({
      date: dateStr,
      session_count: activityMap.get(dateStr) ?? 0,
    });
    current.setDate(current.getDate() + 1);
  }

  return activity;
}
