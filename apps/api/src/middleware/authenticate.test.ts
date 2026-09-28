import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  authenticate,
  authenticateOptional,
  tokenRevocationKey,
} from "./authenticate";

const SECRET = "test_secret_test_secret_test_secret_123";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
}));

vi.mock("../lib/config", () => ({
  config: {
    JWT_SECRET: "test_secret_test_secret_test_secret_123",
    JWT_ISSUER: "brandblitz-api",
    JWT_AUDIENCE: "brandblitz-client",
  },
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
  },
}));

function mockReq(token?: string) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    user: undefined as any,
  };
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const next = vi.fn();

function signToken(payload: any, options = {}) {
  return jwt.sign(
    { iss: "brandblitz-api", aud: "brandblitz-client", ...payload },
    SECRET,
    options
  );
}

describe("authenticate middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
  });

  it("accepts a valid bearer token", async () => {
    const token = signToken({ sub: "user1", email: "user@example.com" }, { expiresIn: "1h" });
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(req.user.sub).toBe("user1");
    expect(mocks.redisGet).toHaveBeenCalledWith(tokenRevocationKey(token));
    expect(next).toHaveBeenCalled();
  });

  it("rejects a missing token", async () => {
    const req = mockReq();
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a revoked token", async () => {
    const token = signToken({ sub: "user1", email: "user@example.com" }, { expiresIn: "1h" });
    const req = mockReq(token);
    const res = mockRes();
    mocks.redisGet.mockResolvedValue("1");

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an invalid token", async () => {
    const req = mockReq("invalid_token");
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a token with mismatched iss claim", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com", iss: "evil-service", aud: "brandblitz-client" },
      SECRET,
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token with mismatched aud claim", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com", iss: "brandblitz-api", aud: "evil-client" },
      SECRET,
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token with missing iss and aud claims", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com" },
      SECRET,
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("authenticateOptional middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
  });

  it("sets req.user for a valid non-revoked token", async () => {
    const token = signToken({ sub: "user1", email: "user@example.com" }, { expiresIn: "1h" });
    const req = mockReq(token);
    const res = mockRes();

    await authenticateOptional(req as any, res, next);

    expect(req.user.sub).toBe("user1");
    expect(next).toHaveBeenCalled();
  });

  it("continues without user for a revoked optional token", async () => {
    const token = signToken({ sub: "user1", email: "user@example.com" }, { expiresIn: "1h" });
    const req = mockReq(token);
    const res = mockRes();
    mocks.redisGet.mockResolvedValue("1");

    await authenticateOptional(req as any, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("continues without user for optional token with mismatched iss", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com", iss: "wrong", aud: "brandblitz-client" },
      SECRET,
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticateOptional(req as any, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("continues without user for optional token with mismatched aud", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com", iss: "brandblitz-api", aud: "wrong" },
      SECRET,
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticateOptional(req as any, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});

describe("authenticate middleware - additional edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
  });

  it("rejects an expired JWT (past exp) with 401", async () => {
    const token = signToken(
      { sub: "user1", email: "user@example.com" },
      { expiresIn: "-1h" } // Already expired
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("rejects JWT signed with wrong secret with 401", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com", iss: "brandblitz-api", aud: "brandblitz-client" },
      "wrong_secret_entirely",
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("rejects structurally malformed token (not three Base64 segments) with 401", async () => {
    const malformedToken = "not.two.segments";
    const req = mockReq(malformedToken);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects completely malformed token string with 401", async () => {
    const req = mockReq("completely-invalid-token-string");
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects empty Bearer value with 401", async () => {
    const req = {
      headers: { authorization: "Bearer " },
      user: undefined as any,
    };
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not populate req.user when expired JWT error fires", async () => {
    const token = signToken(
      { sub: "user1", email: "user@example.com" },
      { expiresIn: "-1h" } // Already expired
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(req.user).toBeUndefined();
  });

  it("does not populate req.user when wrong secret error fires", async () => {
    const token = jwt.sign(
      { sub: "user1", email: "user@example.com", iss: "brandblitz-api", aud: "brandblitz-client" },
      "wrong_secret",
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(req.user).toBeUndefined();
  });

  it("does not populate req.user when malformed token error fires", async () => {
    const req = mockReq("definitely-not-a-valid-jwt");
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(req.user).toBeUndefined();
  });

  it("sets req.user.id from sub claim for valid token", async () => {
    const token = signToken(
      { sub: "user-id-123", email: "user@example.com" },
      { expiresIn: "1h" }
    );
    const req = mockReq(token);
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(req.user).toBeDefined();
    expect(req.user.sub).toBe("user-id-123");
    expect(next).toHaveBeenCalled();
  });

  it("returns proper JSON error response for all rejection cases", async () => {
    const req = mockReq("invalid-token");
    const res = mockRes();

    await authenticate(req as any, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });
});
