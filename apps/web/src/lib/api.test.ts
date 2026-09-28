import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { createApiClient, parseChallenge, parseLeaderboardEntries } from "./api";

const signOutMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("next-auth/react", () => ({
  signOut: signOutMock,
}));

vi.mock("./toast", () => ({
  toast: { error: toastErrorMock },
}));

describe("createApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets withCredentials to true so cookies are sent on cross-origin requests", () => {
    const client = createApiClient();
    expect(client.defaults.withCredentials).toBe(true);
  });

  it("sets withCredentials to true even when a bearer token is provided", () => {
    const client = createApiClient("test-token");
    expect(client.defaults.withCredentials).toBe(true);
  });

  it("includes the Authorization header when a token is provided", () => {
    const client = createApiClient("my-jwt");
    expect(client.defaults.headers.Authorization).toBe("Bearer my-jwt");
  });

  it("does not include an Authorization header when no token is provided", () => {
    const client = createApiClient();
    expect(client.defaults.headers.Authorization).toBeUndefined();
  });

  it("attaches a 401 response interceptor for authenticated clients", () => {
    const client = createApiClient("token");
    const interceptors = client.interceptors.response as unknown as {
      handlers: Array<{ fulfilled: unknown; rejected: unknown }>;
    };
    expect(interceptors.handlers.length).toBe(1);
  });

  it("attaches the generic response interceptor for unauthenticated clients", () => {
    const client = createApiClient();
    const interceptors = client.interceptors.response as unknown as {
      handlers: Array<{ fulfilled: unknown; rejected: unknown }>;
    };
    expect(interceptors.handlers.length).toBe(1);
  });

  it("shows session-expired toast and calls signOut on 401 (#357)", async () => {
    vi.useFakeTimers();

    const client = createApiClient("my-token");

    // Simulate a 401 from a non-auth endpoint by calling the interceptor's
    // rejected handler directly (avoids the need for a live HTTP server).
    const handlers = (client.interceptors.response as unknown as {
      handlers: Array<{ fulfilled: unknown; rejected: (e: unknown) => Promise<unknown> }>;
    }).handlers;

    const rejectedHandler = handlers[0]?.rejected;
    expect(rejectedHandler).toBeDefined();

    const axiosError = Object.assign(new Error("Unauthorized"), {
      isAxiosError: true,
      response: { status: 401, data: { error: "Token expired" } },
      config: { url: "/users/me", skipErrorToast: false, headers: {} },
    });
    // Mark it so axios.isAxiosError returns true
    Object.setPrototypeOf(axiosError, (axios as typeof axios & { AxiosError: typeof Error }).AxiosError?.prototype ?? Error.prototype);

    const promise = rejectedHandler!(axiosError).catch(() => {/* expected rejection */});

    // Advance past the 1 500 ms delay so signOut fires
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("session has expired"));
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/login" });

    vi.useRealTimers();
  });
});

describe("parseLeaderboardEntries", () => {
  it("parses a valid leaderboard entry array", () => {
    const data = [
      {
        rank: 1,
        userId: "user-1",
        username: "alice",
        displayName: "Alice",
        league: "gold",
        avatarUrl: "https://example.com/avatar.png",
        totalScore: 1500,
        totalEarned: "100.00",
        endedAt: null,
      },
      {
        rank: 2,
        username: "bob",
        avatarUrl: null,
        totalScore: 1200,
        endedAt: "2026-05-30T00:00:00Z",
      },
    ];

    const result = parseLeaderboardEntries(data);
    expect(result).toHaveLength(2);
    expect(result[0].rank).toBe(1);
    expect(result[0].league).toBe("gold");
    expect(result[1].username).toBe("bob");
    expect(result[1].league).toBeUndefined();
  });

  it("throws on invalid data", () => {
    const data = [{ rank: "not-a-number", username: 123 }];
    expect(() => parseLeaderboardEntries(data)).toThrow();
  });
});

describe("parseChallenge", () => {
  const fixture = {
    id: "ch-123",
    brand_id: "b-456",
    challenge_id: "ch-123",
    pool_amount_stroops: "10000000",
    pool_amount_usdc: "100",
    status: "active" as const,
    starts_at: "2026-05-01T00:00:00.000Z",
    ends_at: "2026-05-02T00:00:00.000Z",
    brand_name: "Acme Corp",
    logo_url: "https://example.com/logo.png",
    primary_color: "#112233",
    secondary_color: "#ddeeff",
  };

  it("parses a valid API response fixture", () => {
    const result = parseChallenge(fixture);
    expect(result.id).toBe("ch-123");
    expect(result.brand_name).toBe("Acme Corp");
    expect(result.pool_amount_usdc).toBe("100");
  });

  it("throws on missing required field", () => {
    const { id, ...incomplete } = fixture;
    expect(() => parseChallenge(incomplete)).toThrow();
  });

  it("throws on invalid status value", () => {
    expect(() => parseChallenge({ ...fixture, status: "invalid" })).toThrow();
  });

  it("accepts optional fields as absent", () => {
    const { tagline, ...partial } = fixture;
    expect(() => parseChallenge(partial)).not.toThrow();
  });

  it("accepts ends_at as null", () => {
    expect(() => parseChallenge({ ...fixture, ends_at: null })).not.toThrow();
  });
});
