import { Router, Request, Response } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { captureMessage } from "../lib/sentry";

const router = Router();

const CspReportSchema = z.object({
  "csp-report": z.object({
    "document-uri": z.string().optional(),
    "referrer": z.string().optional(),
    "blocked-uri": z.string().optional(),
    "violated-directive": z.string().optional(),
    "effective-directive": z.string().optional(),
    "original-policy": z.string().optional(),
    "disposition": z.string().optional(),
    "script-sample": z.string().optional(),
    "source-file": z.string().optional(),
    "line-number": z.coerce.number().optional(),
    "column-number": z.coerce.number().optional(),
    "status-code": z.coerce.number().optional(),
  }),
}).strict();

/**
 * CSP Violation Report Endpoint
 *
 * Receives Content-Security-Policy violation reports from browsers.
 * Used to monitor and triage XSS attempts and CSP misconfigurations.
 *
 * Spec: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy-Report-Only
 */
router.post("/", async (req: Request, res: Response) => {
  const parsed = CspReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid csp-report body" });
    return;
  }
  const report = parsed.data["csp-report"];

  if (!report) {
    res.status(400).json({ error: "Missing csp-report body" });
    return;
  }

  // Log CSP violation with context
  logger.warn("CSP violation detected", {
    documentUri: report["document-uri"],
    violatedDirective: report["violated-directive"],
    effectiveDirective: report["effective-directive"],
    originalPolicy: report["original-policy"],
    blockedUri: report["blocked-uri"],
    sourceFile: report["source-file"],
    lineNumber: report["line-number"],
    columnNumber: report["column-number"],
    statusCode: report["status-code"],
    disposition: report.disposition || "report-only",
  });

  // Forward script-src violations to Sentry — these are the most likely
  // indicator of an actual XSS attempt rather than a benign misconfiguration.
  const directive = report["violated-directive"] || report["effective-directive"] || "";
  if (directive.includes("script")) {
    await captureMessage("CSP script violation", { csp: report });
  }

  res.status(204).send();
});

export default router;
