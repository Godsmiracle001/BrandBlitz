import { z } from "zod";

export const configSchema = z.object({
  // Infrastructure
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_SLOW_QUERY_MS: z.coerce.number().int().positive().default(250),
  WARMUP_COMPLETE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  // Session-start brute-force lockout (issue #509). Tunable at runtime via the
  // app_config key `session_start_lockout`; these are the fallback defaults.
  SESSION_START_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(10),
  SESSION_START_LOCKOUT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3_600),

  // Auth
  JWT_SECRET: z.string().min(32),
  /** Set during rotation: the secret being phased out. Both old + new are accepted
   *  simultaneously for the duration of the access-token TTL (15 min). */
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(),
  /** Separate signing secret for refresh tokens. Falls back to JWT_SECRET. */
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_ISSUER: z.string().default("brandblitz-api"),
  JWT_AUDIENCE: z.string().default("brandblitz-client"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_OAUTH_PKCE_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(300),
  /**
   * Comma-separated list of origins permitted by CORS. Required in EVERY
   * environment — there is intentionally no default and no wildcard fallback.
   * A missing value fails config validation at startup; a literal "*" is
   * rejected so permissive CORS can never be configured by accident.
   */
  ALLOWED_ORIGINS: z
    .string({
      required_error:
        "ALLOWED_ORIGINS is required (comma-separated explicit origins, no wildcard)",
    })
    .min(1, "ALLOWED_ORIGINS must list at least one explicit origin")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .refine((origins) => origins.length > 0, {
      message: "ALLOWED_ORIGINS must contain at least one origin",
    })
    .refine((origins) => !origins.includes("*"), {
      message: "ALLOWED_ORIGINS must not contain a wildcard '*'",
    }),
  REFERRER_POLICY: z
    .enum(["strict-origin-when-cross-origin", "no-referrer"])
    .default("strict-origin-when-cross-origin"),

  // Stellar
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  HOT_WALLET_SECRET: z.string().min(1),
  HOT_WALLET_PUBLIC_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),

  // S3 / Storage
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_BRAND_ASSETS: z.string().default("brand-assets"),
  S3_BUCKET_SHARE_CARDS: z.string().default("share-cards"),
  S3_PUBLIC_URL: z.string().url(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SERVICE_SID: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),

  // Logging
  LOG_LEVEL: z
    .enum(["error", "warn", "info", "http", "verbose", "debug", "silly"])
    .default("info"),

  // Error monitoring — absent by default in local dev; set in staging/prod
  SENTRY_DSN: z.string().url().optional(),

  // Session integrity — rotated independently of JWT_SECRET; optional for backwards compat
  SESSION_INTEGRITY_KEY: z.string().min(32).optional(),

  // Phone verification — HMAC salt for hashing phone numbers at rest
  PHONE_HASH_SALT: z.string().min(16).optional(),

  // E2E testing — enables mock Google OAuth flow; never set in production
  E2E_MOCK_GOOGLE_OAUTH: z
    .enum(["true", "false"])
    .optional()
    .default("false"),

  // Worker concurrency
  PAYOUT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // Admin bootstrap — if set, this email is granted admin role on API boot
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),

  // Next.js revalidation — secret for on-demand ISR revalidation
  REVALIDATE_SECRET: z.string().min(16).optional(),
  NEXT_REVALIDATE_URL: z.string().url().optional(),
});
export type Config = z.infer<typeof configSchema>;
