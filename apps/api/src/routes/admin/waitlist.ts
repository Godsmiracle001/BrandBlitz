import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { query } from "../../db/index";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/**
 * GET /admin/waitlist
 * Paginated export of waitlist entries for admin use.
 * Cursor is the last-seen id from the previous page.
 */
router.get("/", async (req, res) => {
  const { limit, cursor } = ListQuerySchema.parse(req.query);

  const rows = await query<{
    id: string;
    email: string;
    referral_code: string | null;
    created_at: string;
  }>(
    `SELECT id, email, referral_code, created_at
     FROM waitlist
     WHERE ($1::uuid IS NULL OR id < $1::uuid)
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [cursor ?? null, limit + 1]
  );

  const hasMore = rows.rows.length > limit;
  const data = rows.rows.slice(0, limit);
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;

  res.json({ data, nextCursor });
});

export default router;
