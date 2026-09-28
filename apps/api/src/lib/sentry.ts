/**
 * sentry.ts — Sentry initialisation for the Express API + BullMQ worker.
 *
 * Install:  pnpm add @sentry/node --filter @brandblitz/api
 *
 * Activation:  Set SENTRY_DSN in the environment.  When SENTRY_DSN is absent
 * (the default in local dev) the module is a no-op — no network calls, no
 * console noise.
 *
 * PII scrubbing:  request body fields listed in SCRUBBED_BODY_KEYS and all
 * Authorization / Cookie / Set-Cookie headers are removed before the event
 * reaches Sentry.
 */

import type { Event, EventHint } from "@sentry/node";

import { config } from "./config";

// Fields in request bodies that must never appear in Sentry events.
const SCRUBBED_BODY_KEYS = new Set([
  "password",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "otp",
  "pin",
  "privateKey",
  "mnemonic",
  "walletSecret",
]);

function scrubBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const scrubbed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    scrubbed[k] = SCRUBBED_BODY_KEYS.has(k) ? "[Filtered]" : v;
  }
  return scrubbed;
}

function scrubHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = { ...headers };
  for (const h of ["authorization", "cookie", "set-cookie"]) {
    if (h in out) out[h] = "[Filtered]";
  }
  return out;
}

function buildBeforeSend(event: Event, _hint: EventHint): Event | null {
  if (event.request) {
    event.request.data = scrubBody(event.request.data);
    event.request.headers = scrubHeaders(event.request.headers as Record<string, string>);
  }
  return event;
}

// Lazily-resolved Sentry module (undefined when @sentry/node is not installed
// or SENTRY_DSN is absent).
let _sentry: typeof import("@sentry/node") | undefined;

async function getSentry(): Promise<typeof import("@sentry/node") | undefined> {
  if (_sentry !== undefined) return _sentry;
  try {
    _sentry = await import("@sentry/node");
  } catch {
    _sentry = undefined;
  }
  return _sentry;
}

/**
 * Call once at process start (before routes are registered).
 * Safe to call multiple times — subsequent calls are ignored by Sentry.
 */
export async function initSentry(): Promise<void> {
  const dsn = config.SENTRY_DSN;
  if (!dsn) return; // off by default in dev

  const Sentry = await getSentry();
  if (!Sentry) return;

  Sentry.init({
    dsn,
    environment: config.NODE_ENV,
    // Source maps are uploaded by CI; do not send raw source here.
    includeLocalVariables: false,
    beforeSend: buildBeforeSend,
  });
}

/**
 * Report an exception to Sentry.  Safe to call even when Sentry is not
 * initialised — the call is a no-op in that case.
 */
export async function captureException(
  err: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  const Sentry = await getSentry();
  if (!Sentry) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/**
 * Synchronous variant for use inside Express error handlers where async is
 * impractical.  Uses the module-level cached reference; will silently no-op
 * if Sentry was not yet initialised.
 */
export function captureExceptionSync(
  err: unknown,
  context?: Record<string, unknown>
): void {
  if (!_sentry) return;
  _sentry.captureException(err, context ? { extra: context } : undefined);
}

/**
 * Report a non-exception event (e.g. a CSP violation) to Sentry.  Safe to
 * call even when Sentry is not initialised — the call is a no-op in that
 * case.
 */
export async function captureMessage(
  message: string,
  context?: Record<string, unknown>
): Promise<void> {
  const Sentry = await getSentry();
  if (!Sentry) return;
  Sentry.captureMessage(message, { level: "warning", extra: context });
}
