import { Router } from "express";
import { z } from "zod";
import { query } from "../../db";
import { createError } from "../../middleware/error";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";

const router: Router = Router();

router.use(authenticate);
router.use(requireAdmin);

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_username: string | null;
  action: string;
  entity: string;
  entity_key: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

const QuerySchema = z
  .object({
    action: z.string().optional(),
    // entityType/entityId map onto this table's entity/entity_key columns.
    // entityId is only meaningful alongside entityType (issue #464).
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    performedBy: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((data) => !data.entityId || data.entityType, {
    message: "entityId requires entityType to also be set",
    path: ["entityId"],
  });

router.get("/", async (req, res) => {
  const { action, entityType, entityId, performedBy, from, to, search, page, pageSize } =
    QuerySchema.parse(req.query);

  let whereConditions: string[] = [];
  const params: unknown[] = [];

  if (action) {
    params.push(action);
    whereConditions.push(`al.action = $${params.length}`);
  }

  if (entityType) {
    params.push(entityType);
    whereConditions.push(`al.entity = $${params.length}`);
  }

  if (entityId) {
    params.push(entityId);
    whereConditions.push(`al.entity_key = $${params.length}`);
  }

  if (performedBy) {
    params.push(performedBy);
    whereConditions.push(`al.actor_id = $${params.length}`);
  }

  if (from) {
    params.push(from);
    whereConditions.push(`al.created_at >= $${params.length}::timestamp`);
  }

  if (to) {
    params.push(to);
    whereConditions.push(`al.created_at <= $${params.length}::timestamp`);
  }

  if (search) {
    params.push(`%${search}%`);
    whereConditions.push(
      `(u.username ILIKE $${params.length} OR al.entity_key ILIKE $${params.length})`
    );
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM audit_log al
     LEFT JOIN users u ON u.id = al.actor_id
     ${whereClause}`,
    params
  );

  const total = countResult.rows[0]?.count ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;

  params.push(pageSize);
  params.push(offset);

  const result = await query<AuditLogEntry>(
    `SELECT
       al.id,
       al.actor_id,
       u.username as actor_username,
       al.action,
       al.entity,
       al.entity_key,
       al.before,
       al.after,
       al.created_at
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.actor_id
     ${whereClause}
     ORDER BY al.created_at DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );

  res.json({
    entries: result.rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
    },
  });
});

export default router;
