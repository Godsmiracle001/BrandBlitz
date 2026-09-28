import type { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis";
import { computeFingerprint } from "../lib/fingerprint";
import { setCookieSecure } from "../lib/cookies";

const PENDING_REFERRAL_TTL_SECONDS = 30 * 24 * 60 * 60;

function readHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return null;
  return code;
}

export async function referralAttributionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const code =
      normalizeCode(req.query.ref) ?? normalizeCode(req.cookies?.ref);
    if (!code) {
      next();
      return;
    }

    const fingerprint = computeFingerprint({
      visitorId: readHeader(req, "x-visitor-id"),
      deviceId: readHeader(req, "x-device-id"),
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    await redis.set(
      `referral:pending:${fingerprint}`,
      code,
      "EX",
      PENDING_REFERRAL_TTL_SECONDS,
    );
    setCookieSecure(res, "ref", code, {
      maxAge: PENDING_REFERRAL_TTL_SECONDS * 1000,
    });

    next();
  } catch (error) {
    next(error);
  }
}
