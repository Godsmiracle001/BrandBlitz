import { Router } from "express";
import { z } from "zod";
import { query } from "../db/index";
import { createError } from "../middleware/error";
import { apiLimiter, waitlistLimiter } from "../middleware/rate-limit";

const router = Router();

const WaitlistSchema = z.object({
  email: z.string().max(254).email(),
  referral_code: z.string().max(64).optional(),
});

router.post("/", waitlistLimiter, async (req, res) => {
  const parsed = WaitlistSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError("Invalid email address", 422, "INVALID_EMAIL");
  }
  const email = parsed.data.email.toLowerCase().trim();

  await query(
    `INSERT INTO waitlist (email, referral_code)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, parsed.data.referral_code ?? null]
  );

  res.status(201).json({ message: "You're on the list!" });
});

router.get("/position/:email", apiLimiter, async (req, res) => {
  const email = z.string().email().parse(req.params.email);
  const result = await query<{ position: number }>(
    "SELECT position FROM waitlist_signups WHERE email = $1",
    [email.toLowerCase().trim()]
  );

  if (result.rows.length === 0) {
    throw createError("Email not found on waitlist", 404);
  }

  res.json({ position: result.rows[0].position });
});

export default router;
