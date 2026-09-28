/**
 * OpenAPI schemas for /auth routes (#143).
 *
 * Lives in its own file so it can be imported lazily by the
 * generator without dragging in the route handlers' runtime deps
 * (DB, Stellar SDK, etc.).
 */

import { z } from "zod";
import { registerEndpoint } from "@/lib/openapi-registry";

const UserSchema = z
  .object({
    id: z.string().openapi({ example: "usr_abc123" }),
    email: z.string().email(),
    name: z.string().nullable().optional(),
    googleId: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
  })
  .openapi("User");

const TokenPair = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi("TokenPair");

const ErrorShape = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  })
  .openapi("ErrorEnvelope");

registerEndpoint({
  method: "post",
  path: "/auth/google/callback",
  tags: ["auth"],
  summary: "Exchange a Google ID token for a BrandBlitz session",
  request: { body: z.object({ idToken: z.string().min(1) }) },
  responses: {
    200: {
      description: "Authenticated",
      schema: TokenPair.extend({ user: UserSchema }).openapi("AuthResponse"),
    },
    401: { description: "Invalid Google ID token", schema: ErrorShape },
  },
});

registerEndpoint({
  method: "get",
  path: "/auth/me",
  tags: ["auth"],
  summary: "Return the authenticated user's profile",
  authenticated: true,
  responses: {
    200: { description: "OK", schema: z.object({ user: UserSchema }) },
    401: { description: "Missing or invalid bearer token", schema: ErrorShape },
    404: { description: "User no longer exists", schema: ErrorShape },
  },
});

registerEndpoint({
  method: "post",
  path: "/auth/refresh",
  tags: ["auth"],
  summary: "Rotate access + refresh tokens; detects refresh-token reuse",
  request: { body: z.object({ refreshToken: z.string().min(1) }) },
  responses: {
    200: { description: "Rotated", schema: TokenPair },
    401: { description: "Invalid or reused refresh token", schema: ErrorShape },
  },
});

registerEndpoint({
  method: "post",
  path: "/auth/logout",
  tags: ["auth"],
  summary: "Invalidate the current refresh token",
  request: { body: z.object({ refreshToken: z.string().min(1).optional() }) },
  responses: {
    204: { description: "Logged out" },
  },
});
