import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock("../lib/redis", () => ({
  redis: {
    set: mocks.redisSet,
    get: mocks.redisGet,
    del: mocks.redisDel,
  },
}));

import {
  createCodeChallenge,
  createGooglePkceAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
} from "./google-auth";

describe("google-auth PKCE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an S256 authorization URL and stores a short-lived verifier in Redis", async () => {
    mocks.redisSet.mockResolvedValue("OK");

    const challenge = await createGooglePkceAuthorizationUrl("/dashboard");
    const url = new URL(challenge.authorizationUrl);
    const stored = JSON.parse(mocks.redisSet.mock.calls[0][1]);

    expect(challenge.codeChallengeMethod).toBe("S256");
    expect(stored.codeVerifier).toHaveLength(43);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createCodeChallenge(stored.codeVerifier));
    expect(url.searchParams.get("state")).toBe(challenge.state);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      `oauth:google:pkce:${challenge.state}`,
      expect.any(String),
      "EX",
      300,
      "NX"
    );
  });

  it("retrieves the verifier by state and sends it during token exchange", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id_token: "google-id-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: "google-123",
          email: "player@example.com",
          aud: "test-google-client-id",
          email_verified: "true",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    mocks.redisGet.mockResolvedValue(JSON.stringify({ codeVerifier: "a".repeat(43) }));
    mocks.redisDel.mockResolvedValue(1);

    const profile = await exchangeGoogleAuthorizationCode({
      code: "auth-code",
      state: "state-123",
    });

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("a".repeat(43));
    expect(mocks.redisGet).toHaveBeenCalledWith("oauth:google:pkce:state-123");
    expect(mocks.redisDel).toHaveBeenCalledWith("oauth:google:pkce:state-123");
    expect(profile.googleId).toBe("google-123");

    vi.unstubAllGlobals();
  });
});
