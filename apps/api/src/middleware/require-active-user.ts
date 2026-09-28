import type { Request, Response, NextFunction } from "express";
import { findUserById } from "../db/queries/users";
import { createError } from "./error";

/**
 * Middleware that gates paid/competitive routes behind an active account.
 * Suspended users receive a 403 with code ACCOUNT_SUSPENDED.
 *
 * Must be placed AFTER `authenticate` in the middleware chain so `req.user`
 * is already populated.
 *
 * Closes #140
 */
export async function requireActiveUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.user?.sub;
  if (!userId) {
    throw createError("Authentication required", 401, "UNAUTHENTICATED");
  }

  const user = await findUserById(userId);
  if (!user) {
    throw createError("User not found", 404, "USER_NOT_FOUND");
  }

  if (user.status === "suspended" || user.suspended_at !== null) {
    throw createError(
      "Your account has been suspended. Please contact support for assistance.",
      403,
      "ACCOUNT_SUSPENDED",
    );
  }

  next();
}
