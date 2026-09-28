# RFC 1254: Extract anti-cheat scoring/decision logic out of Express middleware into a standalone service

## Problem Statement

`apps/api/src/middleware/anti-cheat.ts` (484 lines) mixes request/response concerns
(`req.body` extraction, `next()` calls, `throw createError(...)` HTTP semantics) with the
actual fraud-detection business logic (speed/reaction-time thresholds, clock-skew
tolerance, round-score bounds, session-start lockout). This makes the fraud rules hard to
unit-test independent of an Express request/response cycle, and hard to reuse from
anywhere that isn't already inside this middleware chain — most concretely, the admin
fraud-review surface (`apps/api/src/routes/admin/fraud.ts`) can only list and update
*already-recorded* flags today; it has no way to re-run the actual decision logic against
a session (e.g. "would this reaction time still trip a flag under today's thresholds?").

This mirrors the exact shape of [RFC 1264](./1264-scoring-engine-extraction.md) (scoring
engine extraction) — that RFC's own Open Questions section asked whether anti-cheat logic
should move into the scoring engine or stay separate. This RFC proposes anti-cheat gets
the *same treatment*, as its own standalone service, kept separate from scoring (they
overlap conceptually — a flagged session can affect whether a score counts — but fraud
detection and score calculation are different concerns with different inputs).

## Current State

### anti-cheat.ts Structure

```
apps/api/src/middleware/anti-cheat.ts (484 lines)
├── Constants
│   ├── BOT_REACTION_THRESHOLD_MS (80)
│   ├── MIN_HUMAN_REACTION_MS (150)
│   ├── MAX_HUMAN_REACTION_MS (30_000)
│   └── MAX_CLOCK_SKEW_MS (5000)
├── Shared helpers
│   ├── getThresholds() — reads app_config (5s Redis cache) w/ fallback to defaults
│   ├── resolveSessionId(req) — Express-specific
│   └── recordFraudFlag(req, type, details) — writes via db/queries/fraud-flags,
│         reads req context (Express-specific)
├── Layer 1 — detectClockSkew(req, res, next)
│   Pure decision: |serverTime - clientTimestamp| > MAX_CLOCK_SKEW_MS
├── Layer 2 — validateReactionTime(req, res, next)
│   Pure decision: reactionTimeMs vs BOT_REACTION_THRESHOLD_MS / thresholds.{min,max}
├── enforceOneSessionPerChallenge(req, res, next)
│   DB-coupled: relies on a UNIQUE constraint + atomic replace, not a pure decision
├── validateDeviceFingerprint(req, res, next)
│   Mix: computeFingerprint() (pure) + DB session lookup (coupled)
├── validateRoundScore(req, res, next)
│   Pure decision: roundScore vs MAX_ROUND_SCORE bounds
├── Session-start brute-force lockout (issue #509)
│   ├── getSessionStartLockoutConfig() — app_config w/ env fallback
│   ├── writeSessionStartLockoutAudit()
│   └── requireSessionStartAllowed(req, res, next) — Redis-counter-based, not pure
└── assertValidTotalScore(totalScore) — already a plain function, no Express coupling
```

### Current Dependencies

- `lib/redis` (session-start lockout counters)
- `db/queries/fraud-flags` (`createFraudFlag`)
- `db/queries/config` (`getConfig` — runtime-tunable thresholds)
- `db/queries/sessions` (`getSession`, `claimSession`)
- `lib/fingerprint` (`computeFingerprint`)
- `lib/metrics`, `lib/logger`
- `services/scoring` (`MAX_ROUND_SCORE`, `MAX_TOTAL_SCORE`)
- `db` (raw `query`)

### Which parts are pure business logic vs Express-specific plumbing

| Function | Pure decision logic | Express/req-response plumbing |
| --- | --- | --- |
| `detectClockSkew` | `Math.abs(serverTime - clientTimestamp) > MAX_CLOCK_SKEW_MS` | `req.body` read, `next()`, `throw createError(...)` |
| `validateReactionTime` | Threshold comparisons against `BOT_REACTION_THRESHOLD_MS` / tunable `min`/`max` | `req.body` read, `next()` |
| `validateRoundScore` | `roundScore` range check against `MAX_ROUND_SCORE` | `req.body` read, `next()`, `throw createError(...)` |
| `assertValidTotalScore` | Already pure — no change needed | — |
| `enforceOneSessionPerChallenge` | The *decision* ("is there already an active session?") is really "ask the DB", not computable in isolation | Fully DB- and Express-coupled; **not** a good extraction candidate as-is |
| `validateDeviceFingerprint` | `computeFingerprint()` itself is pure | Session lookup + comparison against stored fingerprint is DB-coupled |
| `requireSessionStartAllowed` (lockout) | The threshold/window comparison is a pure decision given a count | Redis counter increment/read is an external side effect, not pure |
| `recordFraudFlag` | The flag `type`/`details`/`severity` shape it builds *is* useful to extract | The DB write and `req` context extraction are plumbing |

Roughly: the **fixed-threshold comparisons** (clock skew, reaction time, round score) are
cleanly pure today — they take a number and a threshold and return a decision, with no
DB or Express dependency once the threshold itself is resolved. The **stateful checks**
(one-session-per-challenge, fingerprint-against-stored-session, lockout-counter) are
inherently *not* pure — they need a data source (DB row, Redis counter). This RFC treats
those two groups differently rather than forcing everything into one pure module.

## Proposed Architecture

### Pure Decision Module

Create `apps/api/src/services/anti-cheat.service.ts` with the threshold-based rules as
plain functions, mirroring `scoring.engine.ts`'s shape from RFC 1264:

```typescript
// Pure input/output, no DB or Express dependency
export interface ClockSkewInput {
  clientTimestamp: number;
  serverTime: number;
  maxSkewMs: number;
}

export interface ReactionTimeInput {
  reactionTimeMs: number;
  botThresholdMs: number;
  minHumanMs: number;
  maxHumanMs: number;
}

export interface RoundScoreInput {
  roundScore: number;
  maxRoundScore: number;
}

export type FraudDecision =
  | { flagged: false }
  | { flagged: true; type: string; severity: "info" | "warning" | "critical"; details: Record<string, unknown>; blocking: boolean };

// Pure functions: no side effects, no DB/Redis calls, no req/res
export function evaluateClockSkew(input: ClockSkewInput): FraudDecision { /* ... */ }
export function evaluateReactionTime(input: ReactionTimeInput): FraudDecision[] { /* ... */ }
export function evaluateRoundScore(input: RoundScoreInput): FraudDecision { /* ... */ }

// The stateful checks (session lockout, fingerprint match) stay OUT of this pure
// module — see "Stateful checks" below.
```

`FraudDecision.blocking` distinguishes decisions that should `throw createError(...)`
(bot-threshold reaction time, round-score out of range, invalid/skewed timestamp) from
ones that only record a flag and continue (reaction time between the bot threshold and
the tunable human range).

### Stateful Checks: Interface, Not Pure Function

`enforceOneSessionPerChallenge`, `validateDeviceFingerprint`'s DB half, and
`requireSessionStartAllowed` depend on external state (DB row, Redis counter). Rather
than force these into the pure module, define narrow interfaces the service depends on,
so the *decision* logic can still be tested with an in-memory fake instead of a real
DB/Redis connection:

```typescript
export interface SessionLockoutStore {
  getFailureCount(userId: string, windowSeconds: number): Promise<number>;
  recordFailure(userId: string, windowSeconds: number): Promise<void>;
}

export function evaluateSessionStartLockout(
  failureCount: number,
  config: SessionStartLockoutConfig
): FraudDecision { /* pure: count vs threshold */ }
```

The store interface is implemented once for real (Redis) and once as an in-memory fake
for tests — the *counting/threshold decision* itself becomes pure and testable without
either.

### Middleware Layer Becomes a Thin Adapter

```typescript
// apps/api/src/middleware/anti-cheat.ts (post-extraction)
import { evaluateReactionTime } from "../services/anti-cheat.service";

export async function validateReactionTime(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const { reactionTimeMs } = req.body as { reactionTimeMs?: number };
  if (reactionTimeMs === undefined) return next();

  const thresholds = await getThresholds();
  const decisions = evaluateReactionTime({
    reactionTimeMs,
    botThresholdMs: BOT_REACTION_THRESHOLD_MS,
    minHumanMs: thresholds.min_human_reaction_ms,
    maxHumanMs: thresholds.max_human_reaction_ms,
  });

  for (const decision of decisions) {
    if (!decision.flagged) continue;
    await recordFraudFlag(req, decision.type, decision.details).catch(() => {});
    if (decision.blocking) {
      throw createError("Reaction time impossible for humans", 403, "REACTION_IMPOSSIBLE");
    }
  }

  next();
}
```

The middleware still owns: reading `req.body`, resolving runtime config/thresholds,
calling `recordFraudFlag` (the DB write + `req` context), and translating a blocking
decision into the right HTTP error. The service owns: what counts as suspicious, given
already-resolved numbers.

### Reuse: Admin Re-evaluation / Batch Re-scoring

This is the concrete payoff. `apps/api/src/routes/admin/fraud.ts` today can only list and
`PATCH` the status of flags already written by the middleware at request time — it can't
ask "would this session still get flagged under the *current* thresholds?" A new
admin endpoint becomes straightforward once the decision logic doesn't need an Express
request:

```typescript
// Hypothetical: apps/api/src/routes/admin/fraud.ts addition
router.post("/re-evaluate/:sessionId", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) throw createError("Session not found", 404);

  const thresholds = await getThresholds();
  const decisions = [
    evaluateReactionTime({ reactionTimeMs: session.reactionTimeMs!, ...thresholds }),
    evaluateRoundScore({ roundScore: session.roundScore!, maxRoundScore: MAX_ROUND_SCORE }),
  ].filter((d) => d.flagged);

  res.json({ decisions }); // Admin reviews; no DB write from this endpoint alone
});
```

Batch re-scoring (re-running every session in a date range against updated thresholds
after a rule change) follows the same shape: load sessions, call the pure functions,
report what *would* flag today without needing to fabricate a fake Express request per
session the way re-running the current middleware directly would require.

## Test Migration Plan

### Unit Tests (Pure Service)

New `anti-cheat.service.unit.test.ts` tests the pure functions directly, no `supertest`/
Express app, no DB or Redis:

```typescript
describe("evaluateReactionTime", () => {
  it("flags as blocking below the bot threshold", () => {
    const decisions = evaluateReactionTime({
      reactionTimeMs: 50,
      botThresholdMs: 80,
      minHumanMs: 150,
      maxHumanMs: 30_000,
    });
    expect(decisions).toContainEqual(
      expect.objectContaining({ flagged: true, blocking: true, type: "reaction_time_bot_threshold" })
    );
  });

  it("flags non-blocking (warning) below the tunable human minimum but above the bot threshold", () => {
    const decisions = evaluateReactionTime({
      reactionTimeMs: 100,
      botThresholdMs: 80,
      minHumanMs: 150,
      maxHumanMs: 30_000,
    });
    expect(decisions).toContainEqual(
      expect.objectContaining({ flagged: true, blocking: false, severity: "warning" })
    );
  });
});
```

### Existing Middleware Tests: Preserved, Not Deleted

Unlike RFC 1264's scoring-engine plan (which retires `scoring.warmup.test.ts` once
coverage moves), the existing `anti-cheat.test.ts`-style middleware tests (HTTP-level,
via `supertest`) should be **kept as-is** — they're the only place verifying the
adapter wiring itself (right status code, right error code, `recordFraudFlag` actually
called, `next()` actually reached on the happy path). The unit tests are additive
coverage for the decision logic in isolation, not a replacement for the integration
tests.

### Migration Steps

1. Extract the three fixed-threshold pure functions (`evaluateClockSkew`,
   `evaluateReactionTime`, `evaluateRoundScore`) into `anti-cheat.service.ts`.
2. Write `anti-cheat.service.unit.test.ts` covering each function's boundary values
   (bot threshold, tunable min/max, `MAX_ROUND_SCORE`).
3. Rewire the three corresponding middleware functions to call the service, preserving
   their existing external behavior (status codes, error codes, flag types) exactly.
4. Run the existing middleware test suite unchanged — it should pass without
   modification if step 3 preserved behavior, and is the acceptance gate for this step.
5. Define `SessionLockoutStore` and extract `evaluateSessionStartLockout`; leave the
   Redis-backed implementation as the sole production adapter.
6. Leave `enforceOneSessionPerChallenge` and the fingerprint-vs-stored-session half of
   `validateDeviceFingerprint` as middleware-only for now — their "decision" is
   inseparable from a live DB read without meaningfully improving testability (see table
   above); revisit only if a concrete reuse need for those specifically shows up.

## Benefits

1. **Reusability**: admin re-evaluation and batch re-scoring become straightforward
   additions instead of requiring a fabricated Express request per session.
2. **Testability**: the threshold rules that most often change (tuning bot/human
   reaction windows, round-score caps) get direct unit tests with no DB/Redis mocking.
3. **Clarity**: reading `anti-cheat.service.ts` tells you the actual fraud rules; reading
   `anti-cheat.ts` tells you how they're wired into the request lifecycle. Currently
   both live in the same 484-line file.
4. **Low migration risk**: existing middleware/integration tests act as a behavior-lock
   during the rewire (step 4), and the stateful checks are deliberately left alone
   rather than forced into an awkward pure shape.

## Open Questions

1. Should `recordFraudFlag`'s flag-shape construction move into the service (returning
   the shape to record) while the DB write itself stays in the middleware? This RFC's
   `FraudDecision` type effectively proposes yes, but the exact division of labor is
   worth confirming against how `admin/fraud.ts` would want to consume decisions that
   were *not* written to the DB (the re-evaluation case).
2. Per RFC 1264's own open question: should fraud decisions factor into the scoring
   engine's output (e.g. a flagged round scores 0), or should scoring stay unaware of
   fraud entirely and rely on the caller to check both? This RFC assumes the latter
   (they stay independent, as stated in the Problem Statement) but the two RFCs should
   agree explicitly before either lands.
3. Is `getThresholds()`'s Redis-cached `app_config` read itself worth extracting into a
   shared "runtime-tunable thresholds" helper, given `getSessionStartLockoutConfig()`
   follows an almost identical shape? Out of scope for this RFC but flagged for a
   follow-up.

## References

- Current files:
  - `apps/api/src/middleware/anti-cheat.ts`
  - `apps/api/src/db/queries/fraud-flags.ts`
  - `apps/api/src/routes/admin/fraud.ts`
- Related RFCs: [#1264](./1264-scoring-engine-extraction.md) (scoring engine extraction —
  same shape, explicitly asked whether anti-cheat should merge with it; this RFC answers
  "no, stay separate")
