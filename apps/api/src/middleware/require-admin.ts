import type { Request, Response, NextFunction } from "express";
import { createError } from "./error";

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    throw createError("No token provided", 401);
  }
  if (req.user.role !== "admin" && req.user.role !== "super_admin") {
    throw createError("Forbidden", 403, "FORBIDDEN");
  }
  next();
}
