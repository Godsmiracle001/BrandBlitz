import { createHmac } from "crypto";
import bcrypt from "bcryptjs";
import twilio from "twilio";
import { createError } from "../middleware/error";
import { config } from "../lib/config";
import { redis } from "../lib/redis";
import { query } from "../db/index";
import { createFraudFlag } from "../db/queries/fraud-flags";

// ── Constants ──────────────────────────────────────────────────────────────────

export const PHONE_HASH_ALGORITHM = "sha256";

// ── Twilio client (lazy, per-request) ─────────────────────────────────────────

function getTwilioClient() {
  return twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
}

function getVerifyServiceSid(): string {
  const serviceSid = config.TWILIO_VERIFY_SERVICE_SID ?? config.TWILIO_SERVICE_SID;
  if (!serviceSid) {
    throw new Error("TWILIO_VERIFY_SERVICE_SID is required");
  }
  return serviceSid;
}

function getPhoneHashSalt(): string {
  const salt = config.PHONE_HASH_SALT;
  if (!salt) {
    throw new Error("PHONE_HASH_SALT is required");
  }
  return salt;
}

// ── Phone normalization & hashing ─────────────────────────────────────────────

export function normalizePhoneNumber(phoneNumber: string): string {
  const trimmed = phoneNumber.trim();
  const normalized = trimmed.startsWith("+")
    ? `+${trimmed.slice(1).replace(/\D/g, "")}`
    : `+${trimmed.replace(/\D/g, "")}`;

  if (!/^\+\d{10,15}$/.test(normalized)) {
    throw createError("Phone number must be a valid E.164 number", 400, "INVALID_PHONE");
  }

  return normalized;
}

export function hashPhoneNumber(phoneNumber: string): string {
  const normalized = normalizePhoneNumber(phoneNumber);
  return createHmac(PHONE_HASH_ALGORITHM, getPhoneHashSalt()).update(normalized).digest("hex");
}

// ── Twilio Verify ─────────────────────────────────────────────────────────────

export async function sendVerificationCode(phoneNumber: string): Promise<void> {
  await getTwilioClient()
    .verify.v2.services(getVerifyServiceSid())
    .verifications.create({
      to: normalizePhoneNumber(phoneNumber),
      channel: "sms",
    });
}

export async function checkVerificationCode(
  phoneNumber: string,
  code: string
): Promise<boolean> {
  const result = await getTwilioClient()
    .verify.v2.services(getVerifyServiceSid())
    .verificationChecks.create({ to: normalizePhoneNumber(phoneNumber), code });

  return result.status === "approved";
}

// ── Brute-force protection ────────────────────────────────────────────────────

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_WINDOW_SECONDS = 3600; // 1-hour rolling window

function otpAttemptsKey(e164Phone: string): string {
  return `otp_attempts:${e164Phone}`;
}

/**
 * Verify a phone OTP with brute-force protection.
 * - Rejects immediately (429) when 5+ failed attempts exist within the rolling
 *   60-minute window.  The lockout is keyed on the E.164 phone number so VPN
 *   rotation cannot evade it.
 * - On failure: increments the attempt counter (sets TTL on first write).
 * - On success: deletes the counter so a real user is never locked out after
 *   a successful verify.
 *
 * Throws a 429 ApiError with a Retry-After header value when locked out, a 400
 * ApiError on a wrong code, or re-throws Twilio errors as-is.
 */
export async function verifyOtpWithBruteForceProtection(
  phoneNumber: string,
  code: string
): Promise<void> {
  const normalized = normalizePhoneNumber(phoneNumber);
  const attemptsKey = otpAttemptsKey(normalized);

  // Check current attempt count BEFORE calling Twilio to avoid wasting API quota.
  const currentStr = await redis.get(attemptsKey);
  const current = currentStr ? parseInt(currentStr, 10) : 0;
  if (current >= OTP_MAX_ATTEMPTS) {
    const ttl = await redis.ttl(attemptsKey);
    const retryAfter = ttl > 0 ? ttl : OTP_WINDOW_SECONDS;
    const err = createError("Too many verification attempts", 429, "OTP_RATE_LIMITED");
    (err as any).retryAfter = retryAfter;
    throw err;
  }

  const approved = await checkVerificationCode(normalized, code);

  if (!approved) {
    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) {
      await redis.expire(attemptsKey, OTP_WINDOW_SECONDS);
    }
    throw createError("Invalid verification code", 400, "INVALID_OTP");
  }

  // Success: clear the lockout counter so subsequent verifications aren't blocked.
  await redis.del(attemptsKey);
}

// ── Local OTP (bcrypt-based) ─────────────────────────────────────────────────

export const OTP_LENGTH = 6;
export const OTP_EXPIRY_SECONDS = 300; // 5-minute TTL
export const OTP_HASH_ROUNDS = 10;

export function generateOtpCode(): string {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

/**
 * Generate a numeric OTP, bcrypt-hash it, and store the hash + expiry on the
 * users row.  Returns the plaintext code for delivery via SMS.
 */
export async function sendOtp(userId: string, phoneNumber: string): Promise<string> {
  const code = generateOtpCode();
  const hash = await bcrypt.hash(code, OTP_HASH_ROUNDS);

  await query(
    `UPDATE users
     SET otp_hash        = $1,
         otp_expires_at  = NOW() + interval '${OTP_EXPIRY_SECONDS} seconds',
         updated_at      = NOW()
     WHERE id = $2`,
    [hash, userId],
  );

  await sendVerificationCode(phoneNumber);
  return code;
}

/**
 * Verify a submitted OTP against the stored bcrypt hash.
 * - Returns true when the code matches and the TTL has not expired.
 * - Returns false when the code is wrong or the OTP has expired.
 * - On failure: increments a Redis attempt counter and flags the account
 *   in fraud_flags after OTP_MAX_ATTEMPTS consecutive failures.
 * - On success: clears the stored hash so it cannot be reused.
 */
export async function verifyOtp(userId: string, code: string): Promise<boolean> {
  const result = await query<{ otp_hash: string | null; otp_expires_at: string | null }>(
    `SELECT otp_hash, otp_expires_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );

  const user = result.rows[0];
  if (!user?.otp_hash) return false;

  // Check expiry
  if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
    return false;
  }

  const valid = await bcrypt.compare(code, user.otp_hash);

  if (valid) {
    // Clear OTP so it cannot be reused
    await query(
      `UPDATE users SET otp_hash = NULL, otp_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [userId],
    );
  } else {
    // Track failed attempts
    const attemptsKey = `otp_user_attempts:${userId}`;
    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) {
      await redis.expire(attemptsKey, OTP_WINDOW_SECONDS);
    }

    if (attempts >= OTP_MAX_ATTEMPTS) {
      await createFraudFlag({
        sessionId: "otp-brute-force",
        userId,
        flagType: "otp_brute_force",
        details: { attempts },
      });
    }
  }

  return valid;
}

// ── Guards ────────────────────────────────────────────────────────────────────

export async function requirePhoneVerified(
  userId: string,
  phoneVerified: boolean
): Promise<void> {
  if (!phoneVerified) {
    throw createError(
      "Phone verification required before claiming rewards",
      403,
      "PHONE_VERIFICATION_REQUIRED"
    );
  }
}