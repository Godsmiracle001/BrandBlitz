import { query } from "../index";

type LeagueTier = "bronze" | "silver" | "gold";

export interface LeagueGroupRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  league: LeagueTier;
  week_start: string;
  group_id: number;
  weekly_points: number;
  rank_in_group: number | null;
}

export async function ensureAssignmentForUserThisWeek(
  userId: string,
  weekStart: string
): Promise<{ league: LeagueTier; group_id: number }> {
  const result = await query<{ league: LeagueTier; group_id: number }>(
    `
    WITH user_league AS (
      SELECT COALESCE(league, 'bronze')::text AS league
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
    ),
    existing AS (
      SELECT league, group_id
      FROM league_assignments
      WHERE user_id = $1 AND week_start = $2
      LIMIT 1
    ),
    target_league AS (
      SELECT league FROM existing
      UNION ALL
      SELECT league FROM user_league WHERE NOT EXISTS (SELECT 1 FROM existing)
      LIMIT 1
    ),
    available_group AS (
      SELECT la.group_id
      FROM league_assignments la
      WHERE la.week_start = $2 AND la.league = (SELECT league FROM target_league)
      GROUP BY la.group_id
      HAVING COUNT(*) < 30
      ORDER BY la.group_id
      LIMIT 1
    ),
    next_group AS (
      SELECT COALESCE((SELECT group_id FROM available_group), COALESCE(MAX(group_id), 0) + 1) AS group_id
      FROM league_assignments la
      WHERE la.week_start = $2 AND la.league = (SELECT league FROM target_league)
    ),
    inserted AS (
      INSERT INTO league_assignments (user_id, league, group_id, week_start)
      SELECT $1, (SELECT league FROM target_league), (SELECT group_id FROM next_group), $2
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING league, group_id
    )
    SELECT league, group_id
    FROM inserted
    UNION ALL
    SELECT league, group_id FROM existing
    LIMIT 1
    `,
    [userId, weekStart]
  );

  return result.rows[0];
}

export async function getCurrentLeagueGroup(
  userId: string,
  weekStart: string
): Promise<{ league: LeagueTier; group_id: number; group: LeagueGroupRow[] } | null> {
  const me = await query<{ league: LeagueTier; group_id: number }>(
    "SELECT league, group_id FROM league_assignments WHERE user_id = $1 AND week_start = $2",
    [userId, weekStart]
  );
  const mine = me.rows[0];
  if (!mine) return null;

  const group = await query<LeagueGroupRow>(
    `
    WITH window AS (
      SELECT $1::date AS start_date, ($1::date + INTERVAL '7 days') AS end_date
    ),
    sums AS (
      SELECT
        gs.user_id,
        COALESCE(SUM(gs.total_score), 0)::bigint AS points
      FROM game_sessions gs, window w
      WHERE gs.status = 'completed'
        AND gs.completed_at >= w.start_date
        AND gs.completed_at < w.end_date
        AND gs.user_id IN (
          SELECT member.user_id
          FROM league_assignments member
          WHERE member.week_start = $1 AND member.league = $2 AND member.group_id = $3
        )
      GROUP BY gs.user_id
    ),
    scoped AS (
      SELECT
        la.user_id,
        la.league,
        la.week_start,
        la.group_id,
        COALESCE(s.points, 0)::bigint AS weekly_points
      FROM league_assignments la
      LEFT JOIN sums s ON s.user_id = la.user_id
      WHERE la.week_start = $1 AND la.league = $2 AND la.group_id = $3
    )
    SELECT
      s.user_id,
      u.display_name,
      u.avatar_url,
      s.league,
      s.week_start,
      s.group_id,
      s.weekly_points,
      ROW_NUMBER() OVER (ORDER BY s.weekly_points DESC, s.user_id ASC) AS rank_in_group
    FROM scoped s
    JOIN users u ON u.id = s.user_id
    WHERE u.deleted_at IS NULL
    ORDER BY s.weekly_points DESC, s.user_id ASC
    LIMIT 30
    `,
    [weekStart, mine.league, mine.group_id]
  );

  return { league: mine.league, group_id: mine.group_id, group: group.rows };
}

export async function recalculateWeeklyPoints(weekStart: string): Promise<void> {
  await query(
    `
    WITH window AS (
      SELECT $1::date AS start_date, ($1::date + INTERVAL '7 days') AS end_date
    ),
    sums AS (
      SELECT
        gs.user_id,
        COALESCE(SUM(gs.total_score), 0)::bigint AS points
      FROM game_sessions gs, window w
      WHERE gs.status = 'completed'
        AND gs.completed_at >= w.start_date
        AND gs.completed_at < w.end_date
      GROUP BY gs.user_id
    )
    UPDATE league_assignments la
    SET weekly_points = COALESCE(s.points, 0)
    FROM window w
    LEFT JOIN sums s ON s.user_id = la.user_id
    WHERE la.week_start = w.start_date
    `,
    [weekStart]
  );
}

export async function rankAndFlagWeek(weekStart: string): Promise<void> {
  await query(
    `
    WITH ranked AS (
      SELECT
        la.id,
        la.league,
        la.group_id,
        la.week_start,
        la.user_id,
        la.weekly_points,
        ROW_NUMBER() OVER (
          PARTITION BY la.league, la.group_id
          ORDER BY la.weekly_points DESC, la.user_id ASC
        ) AS rnk,
        COUNT(*) OVER (PARTITION BY la.league, la.group_id) AS grp_count
      FROM league_assignments la
      WHERE la.week_start = $1::date
    )
    UPDATE league_assignments la
    SET
      rank_in_group = r.rnk,
      promoted = (r.league IN ('bronze', 'silver') AND r.rnk <= 3),
      demoted  = (r.league IN ('silver', 'gold') AND r.rnk > GREATEST(r.grp_count - 3, 0))
    FROM ranked r
    WHERE la.id = r.id
    `,
    [weekStart]
  );
}

export async function getTopGoldUsers(weekStart: string): Promise<{ user_id: string }[]> {
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM league_assignments
     WHERE week_start = $1 AND league = 'gold'
       AND rank_in_group IS NOT NULL AND rank_in_group <= 3`,
    [weekStart]
  );
  return result.rows;
}

export async function getNewlyPromotedUsers(
  weekStart: string
): Promise<{ user_id: string; new_league: LeagueTier }[]> {
  const result = await query<{ user_id: string; new_league: LeagueTier }>(
    `SELECT la.user_id, la.league AS new_league
     FROM league_assignments la
     JOIN league_assignments prev
       ON prev.user_id = la.user_id
      AND prev.week_start = (la.week_start::date - INTERVAL '7 days')::date
     WHERE la.week_start = $1
       AND (
         (la.league = 'silver' AND prev.league = 'bronze') OR
         (la.league = 'gold'   AND prev.league = 'silver')
       )`,
    [weekStart]
  );
  return result.rows;
}

export async function seedWeekAssignments(weekStart: string): Promise<void> {
  await query(
    `
    WITH params AS (
      SELECT $1::date AS week_start, ($1::date - INTERVAL '7 days')::date AS prev_week_start
    ),
    prev AS (
      SELECT la.user_id, la.league, la.promoted, la.demoted
      FROM league_assignments la
      JOIN params p ON la.week_start = p.prev_week_start
    ),
    targets AS (
      SELECT
        u.id AS user_id,
        CASE
          WHEN p.user_id IS NULL THEN 'bronze'
          WHEN p.promoted AND p.league = 'bronze' THEN 'silver'
          WHEN p.promoted AND p.league = 'silver' THEN 'gold'
          WHEN p.demoted AND p.league = 'gold' THEN 'silver'
          WHEN p.demoted AND p.league = 'silver' THEN 'bronze'
          ELSE p.league
        END AS league
      FROM users u
      LEFT JOIN prev p ON p.user_id = u.id
      WHERE u.deleted_at IS NULL
    ),
    numbered AS (
      SELECT
        t.user_id,
        t.league,
        CEIL(ROW_NUMBER() OVER (PARTITION BY t.league ORDER BY t.user_id)::numeric / 30)::int AS group_id
      FROM targets t
    ),
    inserted AS (
      INSERT INTO league_assignments (user_id, league, group_id, week_start)
      SELECT n.user_id, n.league, n.group_id, p.week_start
      FROM numbered n, params p
      WHERE NOT EXISTS (
        SELECT 1 FROM league_assignments la
        WHERE la.user_id = n.user_id AND la.week_start = p.week_start
      )
      RETURNING user_id, league
    )
    UPDATE users u
    SET league = t.league
    FROM targets t, params p
    WHERE u.id = t.user_id
      AND EXISTS (SELECT 1 FROM league_assignments la WHERE la.user_id = u.id AND la.week_start = p.week_start)
    `,
    [weekStart]
  );
}
