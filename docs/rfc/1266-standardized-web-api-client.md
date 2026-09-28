# RFC 1266: Standardize apps/web's API-fetching layer instead of ad hoc fetch calls per route/component

## Problem Statement

`apps/web/src/lib` and component directories (game, leaderboard, brand, admin) each call the API independently with their own fetch/error-handling conventions, with no single typed API client shared across server components, client components, and route handlers. This risks inconsistent error handling and duplicated auth-header logic. We need one typed API client module (generated from or aligned with `docs/openapi.yml`) that all web code paths use.

## Current State

### API Client Inventory

| File | Type | Auth | Error Handling | Retry |
|------|------|------|---|---|
| `apps/web/src/lib/api.ts` | Axios-based | Via interceptor | Custom interceptor | Yes |
| `apps/web/src/lib/auth.ts` | Fetch-based | Manual headers | Ad-hoc try-catch | No |
| Component fetches | Mixed | Scattered | Inconsistent | Inconsistent |
| Server actions | Mixed | Header-based | Try-catch | No |

### Current Fetch Patterns

```typescript
// Pattern 1: Axios client (lib/api.ts)
import { client as apiClient } from "@/lib/api";
const response = await apiClient.get("/leaderboard");

// Pattern 2: Raw fetch (lib/auth.ts)
const response = await fetch(`${API_BASE}/users`, {
  headers: { "Authorization": `Bearer ${token}` }
});

// Pattern 3: Component fetch
const leaderboard = await fetch(`${baseUrl}/api/leaderboard`, {
  // Duplicated error handling, auth headers
});
```

### OpenAPI Spec Status

- `docs/openapi.yml` exists and is auto-generated from `apps/api/src/routes/openapi/*.openapi.ts`
- Generated via `pnpm --filter @brandblitz/api gen:openapi`
- CI ensures spec stays in sync with routes
- **Not currently used for client generation**

### Existing Coverage

| Domain | Client Usage |
|--------|---|
| Auth | Fetch-based, custom headers |
| Leaderboard | Mixed (axios + fetch) |
| Game/Challenges | Mixed |
| Brands | Mixed |
| Admin | Mixed |

## Proposed Approach

### Single Typed API Client

Create `apps/web/src/lib/api-client.ts` with:

```typescript
import type { API } from "@brandblitz/api-client"; // Auto-generated from openapi.yml

type RequestConfig = {
  skipAuth?: boolean;
  timeout?: number;
  retryCount?: number;
};

export class APIClient {
  private token: string | null = null;

  setAuthToken(token: string) {
    this.token = token;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options?: RequestConfig & { body?: unknown }
  ): Promise<T> {
    const url = `${process.env.NEXT_PUBLIC_API_BASE}${path}`;
    
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (!options?.skipAuth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    // Implement retry logic, error normalization, etc.
    return this._fetch<T>(url, { method, headers, body: options?.body });
  }

  // Domain-specific methods (typed)
  async getLeaderboard(filter?: string): Promise<API.LeaderboardResponse> {
    return this.request("GET", `/leaderboard${filter ? `?filter=${filter}` : ""}`);
  }

  async submitChallengeAnswer(sessionId: string, answer: unknown): Promise<API.AnswerResponse> {
    return this.request("POST", `/sessions/${sessionId}/answer`, { body: answer });
  }

  // ... more methods, all typed from OpenAPI spec
}

export const apiClient = new APIClient();
```

### Generation Strategy

#### Option A: Openapi-generator (Recommended)

Use `openapi-generator-cli` to auto-generate TypeScript client from `docs/openapi.yml`:

```bash
pnpm dlx @openapitools/openapi-generator-cli generate \
  -i docs/openapi.yml \
  -g typescript-fetch \
  -o packages/api-client \
  --additional-properties=typescriptThreePlus=true
```

Then wrap with domain methods:

```typescript
import { LeaderboardApi, SessionsApi } from "@brandblitz/api-client-generated";

export class APIClient {
  private leaderboardApi: LeaderboardApi;
  private sessionsApi: SessionsApi;

  async getLeaderboard(): Promise<LeaderboardResponse> {
    return this.leaderboardApi.getLeaderboard();
  }
}
```

#### Option B: Manual Types from OpenAPI

Extract type definitions from `docs/openapi.yml` and write client methods with hand-maintained types. Lower maintenance burden if API is stable; less automation.

### Auth & Cookie Handling

#### Server Components

```typescript
// app/leaderboard/page.tsx (Server Component)
import { apiClient } from "@/lib/api-client";
import { getSession } from "@auth0/nextauth";

export default async function LeaderboardPage() {
  const session = await getSession();
  
  // Set auth token on server-side before request
  if (session?.accessToken) {
    apiClient.setAuthToken(session.accessToken);
  }

  const leaderboard = await apiClient.getLeaderboard();
  return <div>/* render */</div>;
}
```

#### Client Components

```typescript
// components/game/game-widget.tsx (Client Component)
"use client";
import { useSession } from "next-auth/react";
import { apiClient } from "@/lib/api-client";

export function GameWidget() {
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.accessToken) {
      apiClient.setAuthToken(session.accessToken);
    }
  }, [session]);

  async function handleSubmitAnswer(answer: unknown) {
    const result = await apiClient.submitChallengeAnswer(
      sessionId,
      answer
    );
  }

  return <div>/* render */</div>;
}
```

#### Route Handlers

```typescript
// app/api/proxy/leaderboard/route.ts (Route Handler)
import { apiClient } from "@/lib/api-client";
import { getServerSession } from "next-auth";

export async function GET(request: Request) {
  const session = await getServerSession();
  
  if (session?.accessToken) {
    apiClient.setAuthToken(session.accessToken);
  }

  const data = await apiClient.getLeaderboard();
  return Response.json(data);
}
```

### Incremental Adoption

#### Phase 1: Core Domains

1. **Auth**: Migrate `lib/auth.ts` → use `apiClient.login()`, `apiClient.logout()`
2. **Leaderboard**: Migrate all leaderboard fetches → `apiClient.getLeaderboard()`
3. **Sessions**: Migrate challenge session fetches → `apiClient.getSession()`, `apiClient.submitAnswer()`

#### Phase 2: Secondary Domains

4. **Brands**: Migrate brand listing/detail → `apiClient.getBrands()`
5. **User profile**: Migrate `/me` endpoint → `apiClient.getUser()`

#### Phase 3: Admin (Optional)

6. **Admin routes**: Migrate admin panel fetches to use same client with auth checks

### Error Handling Standardization

Define consistent error responses:

```typescript
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "APIError";
  }
}

export const apiClient = {
  async request<T>(...): Promise<T> {
    try {
      const response = await fetch(...);
      
      if (!response.ok) {
        const error = await response.json();
        throw new APIError(
          response.status,
          error.code || "UNKNOWN_ERROR",
          error.message || `HTTP ${response.status}`,
          error.details
        );
      }

      return response.json();
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIError(0, "NETWORK_ERROR", "Failed to fetch");
    }
  }
};
```

### Auth Interception

Centralize auth token refresh:

```typescript
export const apiClient = {
  async request<T>(...): Promise<T> {
    try {
      return await this._fetch<T>(...);
    } catch (error) {
      if (
        error instanceof APIError &&
        error.status === 401 // Unauthorized
      ) {
        // Refresh token, retry once
        const newToken = await refreshAccessToken();
        this.setAuthToken(newToken);
        return await this._fetch<T>(...);
      }
      throw error;
    }
  }
};
```

## File Structure

```
apps/web/
├── src/
│   ├── lib/
│   │   ├── api-client.ts          # Main client class
│   │   ├── api-client.test.ts     # Client tests
│   │   ├── api.ts                 # Deprecated: axios client
│   │   └── auth.ts                # Deprecated: fetch auth
│   └── (components, routes use apiClient)
└── (components, routes use apiClient)
```

## Implementation Checklist

- [ ] **Set up code generation** (if Option A): Add openapi-generator to pnpm workspace
- [ ] **Create `api-client.ts`**: Core client class with retry, error handling, auth
- [ ] **Export domain methods**: `getLeaderboard()`, `submitAnswer()`, etc.
- [ ] **Write tests**: Mock fetch, test error cases, auth flow
- [ ] **Migrate domains incrementally**: Phase 1 (auth, leaderboard, sessions)
- [ ] **Update `CONTRIBUTING.md`**: Require all new API calls use apiClient
- [ ] **Deprecate `api.ts` and `auth.ts`**: Remove once all callers migrated
- [ ] **Type-check**: Ensure no `any` types in client code

## Benefits

1. **Single source of truth**: One client, consistent error handling
2. **Type safety**: Auto-generated types from OpenAPI spec
3. **Auth centralization**: Token refresh, intercept, and injection in one place
4. **Retryability**: Built-in retry logic for transient failures
5. **Testing**: Mock a single client instead of multiple fetch calls
6. **Maintainability**: New features add domain methods, not scatter fetch calls

## Open Questions

1. Should apiClient be a singleton or instantiated per-request (SSR safety)?
2. For Option A (code generation), what breaking-change strategy for generated types?
3. Should rate-limit headers (X-RateLimit-Remaining) be exposed in responses?

## References

- OpenAPI spec: `docs/openapi.yml`
- Current client: `apps/web/src/lib/api.ts` (axios)
- Current auth: `apps/web/src/lib/auth.ts` (fetch)
- Related RFCs: #1263 (test naming), #1264 (scoring), #1267 (referral processor)
