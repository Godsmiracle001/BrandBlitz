import { Router } from "express";
import { z } from "zod";
import { findUserById, upsertUser, updateLastLogin } from "../db/queries/users";
import { createError } from "../middleware/error";
import { authLimiter } from "../middleware/rate-limit";
import { authenticate } from "../middleware/authenticate";
import {
  createGooglePkceAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  verifyGoogleIdToken,
} from "../services/google-auth";
import {
  consumePendingReferralAttribution,
  ensureUserReferralCode,
} from "../services/referrals";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  markJtiUsed,
  registerRefreshJti,
  revokeAllUserRefreshTokens,
  isJtiRevoked,
} from "../lib/tokens";
import { query } from "../db";

const router = Router();

const GoogleAuthorizeSchema = z.object({
  callbackUrl: z.string().default("/"),
});
const GoogleCallbackSchema = z
  .object({
    idToken: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
  })
  .refine((body) => body.idToken || (body.code && body.state), {
    message: "idToken or code and state are required",
  });
const RefreshTokenSchema = z.object({ refreshToken: z.string().min(1) });

function serializeUser(user: {
  id: string;
  email: string;
  display_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
  role?: string | null;
  status?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name ?? null,
    username: user.username ?? null,
    avatarUrl: user.avatar_url ?? null,
    role: (user as any).role ?? "player",
    status: (user as any).status ?? "active",
  };
}

/** POST /auth/google/callback */
router.get("/google/authorize", authLimiter, async (req, res) => {
  const { callbackUrl } = GoogleAuthorizeSchema.parse(req.query);
  const authorization = await createGooglePkceAuthorizationUrl(callbackUrl);
  res.json(authorization);
});

router.post("/google/callback", authLimiter, async (req, res) => {
  const { idToken, code, state } = GoogleCallbackSchema.parse(req.body);
  const profile = idToken
    ? await verifyGoogleIdToken(idToken)
    : await exchangeGoogleAuthorizationCode({ code: code!, state: state! });
  const user = await upsertUser({
    email: profile.email,
    googleId: profile.googleId,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  });
  await ensureUserReferralCode(user.id);
  await consumePendingReferralAttribution(user.id, req);

  // Session fixation prevention: revoke all existing refresh tokens before
  // issuing new credentials so any pre-login token is invalidated.
  await revokeAllUserRefreshTokens(user.id);

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const payload = verifyRefreshToken(refreshToken);
  await registerRefreshJti(user.id, payload.jti);

  // Update last_login and write an audit trail atomically with the new token.
  await updateLastLogin(user.id);
  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      user.id,
      "login",
      "user",
      user.id,
      JSON.stringify({ method: "google_oauth", tokenRotated: true }),
    ],
  );

  res.json({ token: accessToken, refreshToken, user: serializeUser(user) });
});

/** GET /auth/me */
router.get("/me", authenticate, async (req, res) => {
  const user = await findUserById(req.user!.sub);
  if (!user) throw createError("User not found", 404);
  res.json({ user: serializeUser(user) });
});

/** POST /auth/refresh — rotates tokens, detects reuse */
router.post("/refresh", async (req, res) => {
  const { refreshToken } = RefreshTokenSchema.parse(req.body);
  let payload: ReturnType<typeof verifyRefreshToken>;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw createError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
  }

  const alreadyUsed = await markJtiUsed(payload.jti);
  if (alreadyUsed) {
    await revokeAllUserRefreshTokens(payload.sub);
    throw createError(
      "Refresh token reuse detected — all sessions revoked",
      401,
      "TOKEN_REUSE",
    );
  }
  if (await isJtiRevoked(payload.jti))
    throw createError("Refresh token revoked", 401, "TOKEN_REVOKED");

  const user = await findUserById(payload.sub);
  if (!user)
    throw createError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");

  const newAccess = signAccessToken(user);
  const newRefresh = signRefreshToken(user);
  const newPayload = verifyRefreshToken(newRefresh);
  await registerRefreshJti(user.id, newPayload.jti);
  res.json({ token: newAccess, refreshToken: newRefresh });
});

/** POST /auth/logout — invalidates current refresh token */
router.post("/logout", async (req, res) => {
  const body = RefreshTokenSchema.safeParse(req.body);
  if (body.success) {
    try {
      const p = verifyRefreshToken(body.data.refreshToken);
      await markJtiUsed(p.jti);
    } catch {
      /* already invalid */
    }
  }
  res.json({ ok: true });
});

export default router;
