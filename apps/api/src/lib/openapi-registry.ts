/**
 * Central OpenAPI registry (#143).
 *
 * Routes register their request / response zod schemas here at import
 * time; `scripts/gen-openapi.ts` walks the registry and emits the
 * spec. The registry is a thin wrapper around
 * `@asteasolutions/zod-to-openapi` so consumers see a single
 * import-point and so the generator code stays decoupled from the
 * specific OpenAPI library.
 *
 * Usage from a route file:
 *
 *   import { registerEndpoint } from "@/lib/openapi-registry";
 *   import { z } from "zod";
 *
 *   const Body = z.object({ idToken: z.string().min(1) });
 *   const Response = z.object({ accessToken: z.string(), user: UserSchema });
 *
 *   registerEndpoint({
 *     method: "post",
 *     path: "/auth/google/callback",
 *     tags: ["auth"],
 *     summary: "Exchange a Google ID token for a BrandBlitz session",
 *     request: { body: Body },
 *     responses: {
 *       200: { description: "Authenticated", schema: Response },
 *       401: { description: "Invalid Google ID token" },
 *     },
 *   });
 *
 *   router.post("/google/callback", (req, res) => { ... });
 */

import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Patch the project's `z` so `.openapi(...)` modifiers on existing
// schemas are recognised by the registry. Idempotent — safe to call
// from multiple modules.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export interface ResponseShape {
  description: string;
  schema?: z.ZodTypeAny;
  contentType?: string;
}

export interface EndpointOptions {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tags?: string[];
  summary?: string;
  description?: string;
  /** Whether the endpoint requires `Authorization: Bearer ...`. */
  authenticated?: boolean;
  request?: {
    body?: z.ZodTypeAny;
    query?: z.ZodObject<z.ZodRawShape>;
    params?: z.ZodObject<z.ZodRawShape>;
    headers?: z.ZodObject<z.ZodRawShape>;
  };
  responses: Record<number, ResponseShape>;
}

/**
 * Translate a `path` from Express-style (`:id`) to OpenAPI-style
 * (`{id}`) at registration time so route files can use the same
 * literal they hand to Express.
 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

export function registerEndpoint(options: EndpointOptions): void {
  const responses: Record<string, unknown> = {};
  for (const [status, shape] of Object.entries(options.responses)) {
    const content = shape.schema
      ? {
          [shape.contentType ?? "application/json"]: { schema: shape.schema },
        }
      : undefined;
    responses[status] = content ? { description: shape.description, content } : { description: shape.description };
  }
  registry.registerPath({
    method: options.method,
    path: toOpenApiPath(options.path),
    tags: options.tags,
    summary: options.summary,
    description: options.description,
    request: options.request?.body
      ? {
          body: {
            content: {
              "application/json": { schema: options.request.body },
            },
          },
          query: options.request.query,
          params: options.request.params,
          headers: options.request.headers,
        }
      : {
          query: options.request?.query,
          params: options.request?.params,
          headers: options.request?.headers,
        },
    security: options.authenticated ? [{ bearerAuth: [] }] : undefined,
    responses,
  });
}

/**
 * Eagerly imports every route module so its `registerEndpoint(...)`
 * calls fire. Called by the generator (`gen-openapi.ts`) and the
 * `/docs` route handler. We can't auto-discover with `import.meta.glob`
 * because the API runs under tsx without bundling, so the list is
 * maintained explicitly — adding a route means appending it here.
 */
export async function loadAllRouteSchemas(): Promise<void> {
  // The imports are dynamic-async to avoid forcing every consumer to
  // initialise the entire route surface at module-load time (the
  // /docs Express handler only needs the registry once per process,
  // not on every request).
  await import("../routes/openapi/auth.openapi");
  await import("../routes/openapi/sessions.openapi");
  await import("../routes/openapi/challenges.openapi");
  await import("../routes/openapi/leaderboard.openapi");
}
