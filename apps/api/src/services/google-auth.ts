import { createError } from "../middleware/error";
import { config } from "../lib/config";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { redis } from "../lib/redis";

const GoogleTokenInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.union([z.literal("true"), z.literal("false")]).optional(),
  aud: z.string().min(1),
  name: z.string().optional(),
  picture: z.string().url().optional(),
});

const GoogleTokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

export interface VerifiedGoogleUser {
  googleId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

const PKCE_KEY_PREFIX = "oauth:google:pkce:";
const PKCE_STATE_BYTES = 32;
const PKCE_VERIFIER_BYTES = 32;

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createCodeChallenge(codeVerifier: string): string {
  return base64Url(createHash("sha256").update(codeVerifier).digest());
}

function googleRedirectUri(): string {
  return config.GOOGLE_REDIRECT_URI ?? `${config.WEB_URL.replace(/\/$/, "")}/api/auth/callback/google`;
}

export async function createGooglePkceAuthorizationUrl(callbackUrl = "/"): Promise<{
  authorizationUrl: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresIn: number;
}> {
  const state = base64Url(randomBytes(PKCE_STATE_BYTES));
  const codeVerifier = base64Url(randomBytes(PKCE_VERIFIER_BYTES));
  const codeChallenge = createCodeChallenge(codeVerifier);
  const expiresIn = config.GOOGLE_OAUTH_PKCE_TTL_SECONDS;

  const stored = await redis.set(
    `${PKCE_KEY_PREFIX}${state}`,
    JSON.stringify({ codeVerifier, callbackUrl }),
    "EX",
    expiresIn,
    "NX"
  );
  if (stored !== "OK") {
    throw createError("Unable to start Google OAuth flow", 500, "OAUTH_STATE_STORE_FAILED");
  }

  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "select_account",
  });

  return {
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
    expiresIn,
  };
}

async function consumeCodeVerifier(state: string): Promise<string> {
  const key = `${PKCE_KEY_PREFIX}${state}`;
  const raw = await redis.get(key);
  if (!raw) {
    throw createError("Invalid or expired OAuth state", 400, "INVALID_OAUTH_STATE");
  }

  await redis.del(key);
  const parsed = z.object({ codeVerifier: z.string().min(43) }).parse(JSON.parse(raw));
  return parsed.codeVerifier;
}

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleUser> {
  if (config.E2E_MOCK_GOOGLE_OAUTH === "true" && idToken.startsWith("e2e:")) {
    const [, rawEmail = "e2e-player@example.com", rawName = "E2E Player"] = idToken.split(":");
    return {
      googleId: `e2e-${rawEmail}`,
      email: rawEmail,
      name: rawName,
    };
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  if (!response.ok) {
    throw createError("Invalid Google token", 401, "INVALID_GOOGLE_TOKEN");
  }

  const payload = GoogleTokenInfoSchema.parse(await response.json());

  if (payload.email_verified === "false") {
    throw createError("Google email is not verified", 401, "UNVERIFIED_GOOGLE_EMAIL");
  }

  if (config.GOOGLE_CLIENT_ID && payload.aud !== config.GOOGLE_CLIENT_ID) {
    throw createError("Invalid Google token audience", 401, "INVALID_GOOGLE_TOKEN");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    avatarUrl: payload.picture,
  };
}

export async function exchangeGoogleAuthorizationCode(params: {
  code: string;
  state: string;
}): Promise<VerifiedGoogleUser> {
  const codeVerifier = await consumeCodeVerifier(params.state);
  const body = new URLSearchParams({
    code: params.code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: googleRedirectUri(),
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw createError("Invalid Google authorization code", 401, "INVALID_GOOGLE_CODE");
  }

  const tokenResponse = GoogleTokenResponseSchema.parse(await response.json());
  return verifyGoogleIdToken(tokenResponse.id_token);
}
