import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";
import { captureExceptionSync } from "../lib/sentry";
import { BadRequestError } from "@stellar/stellar-sdk";
import { config } from "../lib/config";
import { query } from "../db/index";

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Express 5 global error handler.
 * Express 5 automatically catches async errors — no need for try/catch in route handlers.
 * All thrown errors land here.
 */
export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Best-effort: if an active/warmup session is attached to this request,
  // mark it abandoned with reason 'error' so analytics can distinguish
  // server-error closures from timeouts and explicit quits.
  const sessionId = (req as any).session?.id as string | undefined;
  if (sessionId) {
    void query(
      `UPDATE game_sessions
       SET status = 'abandoned',
           abandon_reason = 'error',
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND status IN ('warmup', 'active')`,
      [sessionId]
    ).catch(() => {});
  }

  let statusCode = err.statusCode;
  let message = err.message;
  const dbCode = (err as any).code;

  if (err instanceof ZodError) {
    statusCode = 400;
    message = "Validation Error";
  } else if (err instanceof BadRequestError) {
    statusCode = 400;
  } else if (dbCode === "23505") {
    statusCode = 409;
    message = "Resource already exists";
  } else if (dbCode === "23503") {
    statusCode = 409;
    message = "Foreign key constraint violation";
  } else if (dbCode === "23514") {
    statusCode = 400;
    message = "Check constraint violation";
  }

  statusCode = statusCode ?? 500;
  const isServerError = statusCode >= 500;
  const nodeEnv = process.env.NODE_ENV ?? config.NODE_ENV;
  const isProduction = nodeEnv === "production";

  if (isServerError) {
    message = "Internal Server Error";
  }

  if (isServerError) {
    logger.error("Unhandled error", {
      err: err.message,
      stack: err.stack,
      method: req.method,
      url: req.url,
    });
    // Report to Sentry with request context; sync so it doesn't delay the response.
    captureExceptionSync(err, { method: req.method, url: req.url });
  }

  const payload: Record<string, unknown> =
    isProduction && isServerError
      ? {
          error: "Internal Server Error",
          requestId: res.locals.requestId,
        }
      : {
          error: message,
        };

  if (!(isProduction && isServerError) && err.code) {
    payload.code = err.code;
  }

  // A few call sites attach client-actionable hints to the error before
  // throwing (e.g. sessions.ts / scoring.ts set remainingMs, phone.ts sets
  // retryAfter). Surface them so callers can act on the value instead of
  // just the error code.
  if (!(isProduction && isServerError)) {
    const remainingMs = (err as any).remainingMs;
    if (typeof remainingMs === "number") {
      payload.remainingMs = remainingMs;
    }
    const retryAfter = (err as any).retryAfter;
    if (typeof retryAfter === "number") {
      payload.retryAfter = retryAfter;
    }
  }

  if (!(isProduction && isServerError) && err instanceof ZodError) {
    payload.details = err.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code,
      // Surface the rejected field names when strict() rejects unknown keys.
      ...(issue.code === "unrecognized_keys"
        ? { keys: (issue as import("zod").ZodUnrecognizedKeysIssue).keys }
        : {}),
    }));
  }

  if (nodeEnv === "development" && err.stack) {
    payload.stack = err.stack;
  }

  res.status(statusCode).json(payload);
}

export function createError(message: string, statusCode: number, code?: string): ApiError {
  const err = new Error(message) as ApiError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
