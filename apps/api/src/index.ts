// Sentry must be initialised before any other imports that use it.
import { initSentry } from "./lib/sentry";
void initSentry();
import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import healthRoutes from "./routes/health";
import { errorHandler } from "./middleware/error";
import { referralAttributionMiddleware } from "./middleware/referral-attribution";
import { apiLimiter } from "./middleware/rate-limit";
import { requireHttps } from "./middleware/require-https";
import { requireJsonContentType } from "./middleware/require-json-content-type";
import { requestId } from "./middleware/request-id";
import { connectDb, closeDb, query } from "./db";
import { connectRedis, redis } from "./lib/redis";
import { payoutQueue } from "./queues/payout.queue";
import { leagueQueue } from "./queues/league.queue";
import { leaderboardRefreshQueue } from "./queues/leaderboard-refresh.queue";
import { logger } from "./lib/logger";
import { config } from "./lib/config";
import { PERMISSIONS_POLICY_HEADER } from "@brandblitz/config";

const app = express();
const PORT = config.PORT;
let isShuttingDown = false;

// ── Security & Parsing ─────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for error pages
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://api.stellar.expert",
          config.S3_PUBLIC_URL,
        ],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
      },
    },
    strictTransportSecurity:
      config.NODE_ENV === "production"
        ? {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
          }
        : false,
    referrerPolicy: {
      policy: config.REFERRER_POLICY,
    },
    xFrameOptions: {
      action: "deny",
    },
    xContentTypeOptions: true,
    xDnsPrefetchControl: {
      allow: false,
    },
    xDownloadOptions: true,
    xPermittedCrossDomainPolicies: {
      permittedPolicies: "none",
    },
  }),
);
// Helmet 8 does not set Permissions-Policy; add it explicitly after Helmet.
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY_HEADER);
  next();
});
// ── CORS — explicit, non-wildcard allow-list enforced at startup ────────────
// `config.ALLOWED_ORIGINS` is validated by Zod (required, no wildcard) so the
// process never starts with a permissive origin list. This defensive guard
// re-asserts that invariant at the middleware layer.
const allowedOrigins = config.ALLOWED_ORIGINS;
if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
  throw new Error(
    "ALLOWED_ORIGINS must be an explicit, non-wildcard list of origins",
  );
}

// ALLOWED_ORIGINS entries may be full URLs ("http://localhost:3000") or
// host[:port] ("localhost:3000") — the latter form is shared with the web
// app's Next.js Server Actions config. Browser Origin headers always carry a
// scheme, so we compare on a scheme-stripped host to accept either form.
const stripScheme = (value: string): string =>
  value.replace(/^https?:\/\//, "");
const allowedOriginHosts = new Set(allowedOrigins.map(stripScheme));
const isOriginAllowed = (origin: string): boolean =>
  allowedOrigins.includes(origin) || allowedOriginHosts.has(stripScheme(origin));

// Reject cross-origin requests from unlisted origins with HTTP 403 BEFORE the
// CORS reflection runs. Requests without an Origin header (same-origin
// navigations, server-to-server, health checks) are allowed through.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({
      error: "Origin not allowed by CORS",
      code: "CORS_ORIGIN_FORBIDDEN",
    });
    return;
  }
  next();
});
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header → non-browser / same-origin request; allow.
      if (!origin || isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      // Unlisted origin — already 403'd above; do not emit CORS headers.
      callback(null, false);
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(requireHttps);
app.use(requestId);
app.use(referralAttributionMiddleware);
app.use(requireJsonContentType);
app.use(
  compression({
    threshold: 1024,
  })
);
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      if (
        req.headers["x-webhook-signature"] ||
        req.path.startsWith("/webhooks")
      ) {
        (req as any).rawBody = buf;
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// ── Global rate limit ──────────────────────────────────────────────────────
app.use(apiLimiter);

// ── Health check (before auth middleware) ──────────────────────────────────
app.use(
  "/health",
  (_req, res, next) => {
    if (isShuttingDown) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    next();
  },
  healthRoutes
);

// ── API Routes ─────────────────────────────────────────────────────────────
registerRoutes(app);

// ── Global error handler (Express 5 — catches async throws automatically) ──
app.use(errorHandler);

export { app };

// ── Start ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await connectDb();
  await connectRedis();

  // ── Admin bootstrap ──────────────────────────────────────────────────────
  if (config.ADMIN_BOOTSTRAP_EMAIL) {
    const result = await query(
      "UPDATE users SET role = 'admin', updated_at = NOW() WHERE email = $1 AND deleted_at IS NULL AND role != 'admin' RETURNING id, email",
      [config.ADMIN_BOOTSTRAP_EMAIL]
    );
    if (result.rows.length > 0) {
      logger.info(`Admin role granted to bootstrap email: ${result.rows[0].email}`);
    } else {
      logger.info(`Admin bootstrap: ${config.ADMIN_BOOTSTRAP_EMAIL} already admin or not found`);
    }
  }

  const server = app.listen(PORT, () => {
    logger.info(`API running on port ${PORT}`, { env: config.NODE_ENV });
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — starting graceful shutdown`);
    isShuttingDown = true;

    server.close(async () => {
      try {
        await payoutQueue.close();
        await leagueQueue.close();
        await leaderboardRefreshQueue.close();
        await closeDb();
        await redis.disconnect();
        logger.info("Shutdown complete");
        process.exit(0);
      } catch (err) {
        logger.error("Error during shutdown", { err });
        process.exit(1);
      }
    });

    // Force exit after 10s if server hasn't closed
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (config.NODE_ENV !== "test") {
  start().catch((err) => {
    logger.error("Failed to start API", { err });
    process.exit(1);
  });
}
