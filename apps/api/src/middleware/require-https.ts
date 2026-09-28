import type { Request, Response, NextFunction } from "express";
import { config } from "../lib/config";

export function requireHttps(req: Request, res: Response, next: NextFunction): void {
  if ((process.env.NODE_ENV ?? config.NODE_ENV) !== "production") {
    next();
    return;
  }

  const proto = req.headers["x-forwarded-proto"] as string | undefined;
  if (proto !== "https") {
    res.status(403).json({ error: "TLS required" });
    return;
  }

  next();
}
