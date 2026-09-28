# RFC 1255: Consolidate Next.js on-demand revalidation endpoints behind one signed webhook contract

## Problem Statement

Two separate Next.js route handlers exist for on-demand ISR revalidation, each with its
own auth check:

- `apps/web/src/app/api/revalidate/route.ts` — generic, accepts `{ secret, paths[],
  tags[] }`, checks `body.secret !== REVALIDATION_SECRET`.
- `apps/web/src/app/api/revalidate/leaderboard/route.ts` — single-purpose, hardcodes
  `revalidatePath("/leaderboard")`, checks `secret !== REVALIDATE_SECRET`.

**This is worse than simple duplication — the two auth checks already read different
environment variables**: `REVALIDATION_SECRET` vs `REVALIDATE_SECRET`. Whether that's a
typo or an intentional split, it means a deployment can have one endpoint correctly
configured and the other silently 500ing (the leaderboard route explicitly checks for
this and returns `500` if its var is unset) or, worse, accepting an empty/undefined
secret if an operator assumes there's only one var to set. `apps/api/src/lib/
revalidate.ts` — the only caller found in this codebase — only ever calls the
leaderboard endpoint today; the generic endpoint currently has no caller in-repo, though
its existence and route registration mean it's still reachable in production.

Every new cache tag that needs revalidation today means either: (a) reusing the generic
endpoint (fine, but it's evidently not being used that way), or (b) adding a third
route handler shaped like the leaderboard one, growing this duplication further.

## Current State

### `apps/web/src/app/api/revalidate/route.ts`
```typescript
export async function POST(request: NextRequest) {
  const body = await request.json();
  if (body.secret !== REVALIDATION_SECRET) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }
  for (const path of body.paths ?? []) revalidatePath(path);
  for (const tag of body.tags ?? []) revalidateTag(tag);
  return NextResponse.json({ success: true });
}
```
Accepts arbitrary `paths[]`/`tags[]` — already general-purpose in shape. Uses
`process.env.REVALIDATION_SECRET`.

### `apps/web/src/app/api/revalidate/leaderboard/route.ts`
```typescript
export async function POST(request: Request) {
  const { secret } = await request.json();
  const expectedSecret = process.env.REVALIDATE_SECRET;
  if (!expectedSecret) return NextResponse.json({ error: "..." }, { status: 500 });
  if (!secret || secret !== expectedSecret) return NextResponse.json({ error: "..." }, { status: 401 });
  revalidatePath("/leaderboard");
  return NextResponse.json({ revalidated: true, path: "/leaderboard", timestamp: ... });
}
```
Single-purpose. Uses `process.env.REVALIDATE_SECRET` — a **different variable name**
than the generic endpoint.

### `apps/api/src/lib/revalidate.ts`
```typescript
export async function revalidateLeaderboard(): Promise<void> {
  if (!config.NEXT_REVALIDATE_URL || !config.REVALIDATE_SECRET) { ... return; }
  await fetch(`${config.NEXT_REVALIDATE_URL}/api/revalidate/leaderboard`, {
    method: "POST",
    body: JSON.stringify({ secret: config.REVALIDATE_SECRET }),
  });
}
```
Only calls the leaderboard-specific route. There is no `revalidateTag`/`revalidatePath`
generic caller anywhere in `apps/api` today — the generic endpoint is unused by any
in-repo caller, despite existing and being reachable.

## Proposed Solution

### Single endpoint, single payload shape

Replace both routes with one handler at `apps/web/src/app/api/revalidate/route.ts`:

```typescript
import { revalidatePath, revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET;

interface RevalidateRequest {
  secret: string;
  tags?: string[];
  paths?: string[];
}

export async function POST(request: NextRequest) {
  if (!REVALIDATE_SECRET) {
    return NextResponse.json({ error: "Server misconfigured: REVALIDATE_SECRET not set" }, { status: 500 });
  }

  let body: RevalidateRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.secret !== REVALIDATE_SECRET) {
    return NextResponse.json({ error: "Unauthorized: invalid or missing secret" }, { status: 401 });
  }

  const revalidated = { paths: [] as string[], tags: [] as string[] };
  for (const path of body.paths ?? []) {
    if (typeof path === "string") { revalidatePath(path); revalidated.paths.push(path); }
  }
  for (const tag of body.tags ?? []) {
    if (typeof tag === "string") { revalidateTag(tag); revalidated.tags.push(tag); }
  }

  return NextResponse.json({ revalidated, timestamp: new Date().toISOString() });
}
```

One env var (`REVALIDATE_SECRET`, keeping the name the API side already sends —
`config.REVALIDATE_SECRET` — so no config rename is needed on the caller), one auth
check, one route. `apps/web/src/app/api/revalidate/leaderboard/route.ts` is deleted.

### Corresponding change in `apps/api/src/lib/revalidate.ts`

```typescript
export async function revalidate(input: { tags?: string[]; paths?: string[] }): Promise<void> {
  if (!config.NEXT_REVALIDATE_URL || !config.REVALIDATE_SECRET) {
    logger.debug("Skipping revalidation: NEXT_REVALIDATE_URL or REVALIDATE_SECRET not configured");
    return;
  }
  try {
    const response = await fetch(`${config.NEXT_REVALIDATE_URL}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.REVALIDATE_SECRET, ...input }),
    });
    if (!response.ok) {
      logger.warn("Revalidation failed", { status: response.status, statusText: response.statusText, input });
      return;
    }
    logger.info("Revalidated", { input, data: await response.json() });
  } catch (error) {
    logger.error("Failed to trigger revalidation", { error: error instanceof Error ? error.message : String(error), input });
  }
}

// Thin wrapper preserving the existing call sites/name during migration.
export const revalidateLeaderboard = () => revalidate({ paths: ["/leaderboard"] });
```

Existing callers of `revalidateLeaderboard()` keep working unchanged; new call sites
call `revalidate({ tags: [...] })` or `revalidate({ paths: [...] })` directly.

### Adding new cache tags going forward

No new route handler, ever. A new invalidation need is just a new call:
`revalidate({ tags: ["brand:123"] })` from wherever the mutation happens in
`apps/api`. The web side needs zero changes as long as the page/fetch that should be
invalidated was tagged with a matching `next: { tags: [...] }` fetch option or
`revalidateTag`-compatible cache entry — that tagging discipline (not route-handler
count) becomes the only thing to get right per new cache key.

## Benefits

1. One auth check, one env var name — closes the `REVALIDATION_SECRET` vs
   `REVALIDATE_SECRET` drift that exists today.
2. No new route handler per cache key — the generic payload shape already supports
   arbitrary tags/paths.
3. Existing `revalidateLeaderboard()` call sites in `apps/api` don't need to change
   immediately — the thin wrapper preserves them during migration.
4. One place (`apps/web/src/app/api/revalidate/route.ts`) to add rate limiting,
   request logging, or a stricter payload schema later, instead of two.

## Migration Plan

1. Add the unified handler and the `revalidate()` function alongside the existing code
   (both endpoints stay live).
2. Point `apps/api`'s `revalidateLeaderboard()` call sites at the new `revalidate()`
   wrapper.
3. Confirm `REVALIDATE_SECRET` is set consistently in every deployment env (staging,
   prod) — since the generic endpoint's `REVALIDATION_SECRET` var name is being
   retired, double check nothing outside this repo (an infra/ops script, a webhook
   configured in a third-party dashboard) still sends the old name.
4. Delete `apps/web/src/app/api/revalidate/leaderboard/route.ts` and the old
   `REVALIDATION_SECRET`-reading code path.

## Open Questions

1. Should the unified endpoint validate `tags`/`paths` against an allowlist (so a
   misconfigured caller can't `revalidatePath("/")` the entire site), or is trusting
   the shared secret sufficient given it's already an internal service-to-service
   call? The current generic endpoint has no such allowlist today.
2. Is there any external (non-`apps/api`) caller of either endpoint today — e.g. a
   manually-triggered ops script or a third-party webhook — that this migration would
   need to account for? Nothing was found in-repo, but that doesn't rule out an
   external caller hitting the URL directly.

## References

- Current files:
  - `apps/web/src/app/api/revalidate/route.ts`
  - `apps/web/src/app/api/revalidate/leaderboard/route.ts`
  - `apps/api/src/lib/revalidate.ts`
