import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { sub: "user-123", email: "alice@example.com" };
    return next();
  },
}));

vi.mock("../../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
}));

const {
  mockFindUserById,
  mockFindPendingErasureRequest,
  mockFindPendingSelfErasureRequest,
  mockCreateErasureRequest,
  mockCancelErasureRequest,
  mockEnqueueGdprErasure,
  mockCancelGdprErasure,
} = vi.hoisted(() => ({
  mockFindUserById: vi.fn(),
  mockFindPendingErasureRequest: vi.fn(),
  mockFindPendingSelfErasureRequest: vi.fn(),
  mockCreateErasureRequest: vi.fn(),
  mockCancelErasureRequest: vi.fn(),
  mockEnqueueGdprErasure: vi.fn(),
  mockCancelGdprErasure: vi.fn(),
}));

vi.mock("../../db/queries/users", () => ({
  findUserById: mockFindUserById,
}));

vi.mock("../../db/queries/gdpr", () => ({
  findPendingErasureRequest: mockFindPendingErasureRequest,
  findPendingSelfErasureRequest: mockFindPendingSelfErasureRequest,
  createErasureRequest: mockCreateErasureRequest,
  cancelErasureRequest: mockCancelErasureRequest,
}));

vi.mock("../../queues/gdpr-erasure.queue", () => ({
  enqueueGdprErasure: mockEnqueueGdprErasure,
  cancelGdprErasure: mockCancelGdprErasure,
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── app setup ────────────────────────────────────────────────────────────────

import deleteAccountRoutes from "./delete-account";
import { errorHandler } from "../../middleware/error";

let app: express.Express;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use("/me/delete-account", deleteAccountRoutes);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.resetAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("POST /me/delete-account", () => {
  it("returns 403 when email does not match the user's account email", async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: "user-123",
      email: "alice@example.com",
    });

    const res = await request(app)
      .post("/me/delete-account")
      .send({ email: "wrong@example.com" })
      .expect(403);

    expect(res.body.error).toBe("Email confirmation does not match your account email");
    expect(mockCreateErasureRequest).not.toHaveBeenCalled();
    expect(mockEnqueueGdprErasure).not.toHaveBeenCalled();
  });

  it("returns 202 and enqueues job when email matches", async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: "user-123",
      email: "alice@example.com",
    });
    mockFindPendingErasureRequest.mockResolvedValueOnce(null);
    const fakeRequest = {
      id: "req-abc",
      user_id: "user-123",
      execute_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    };
    mockCreateErasureRequest.mockResolvedValueOnce(fakeRequest);
    mockEnqueueGdprErasure.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/me/delete-account")
      .send({ email: "alice@example.com" })
      .expect(202);

    expect(res.body.executeAt).toBe(fakeRequest.execute_at);
    expect(mockCreateErasureRequest).toHaveBeenCalledWith("user-123");
    expect(mockEnqueueGdprErasure).toHaveBeenCalledWith({
      userId: "user-123",
      requestId: "req-abc",
    });
  });

  it("returns 202 with case-insensitive email match", async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: "user-123",
      email: "Alice@Example.COM",
    });
    mockFindPendingErasureRequest.mockResolvedValueOnce(null);
    mockCreateErasureRequest.mockResolvedValueOnce({
      id: "req-xyz",
      user_id: "user-123",
      execute_at: new Date().toISOString(),
    });

    await request(app)
      .post("/me/delete-account")
      .send({ email: "alice@example.com" })
      .expect(202);
  });

  it("returns 409 when a deletion request is already pending", async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: "user-123",
      email: "alice@example.com",
    });
    mockFindPendingErasureRequest.mockResolvedValueOnce({ id: "existing-req" });

    const res = await request(app)
      .post("/me/delete-account")
      .send({ email: "alice@example.com" })
      .expect(409);

    expect(res.body.error).toMatch(/already pending/);
    expect(mockEnqueueGdprErasure).not.toHaveBeenCalled();
  });

  it("returns 404 when user is not found", async () => {
    mockFindUserById.mockResolvedValueOnce(null);

    await request(app)
      .post("/me/delete-account")
      .send({ email: "alice@example.com" })
      .expect(404);
  });

  it("returns 400 for invalid email body", async () => {
    await request(app)
      .post("/me/delete-account")
      .send({ email: "not-an-email" })
      .expect(400);
  });
});

describe("DELETE /me/delete-account", () => {
  it("returns 200 and cancels a self-initiated request", async () => {
    mockFindPendingSelfErasureRequest.mockResolvedValueOnce({ id: "req-abc", admin_id: null });
    mockCancelErasureRequest.mockResolvedValueOnce(undefined);
    mockCancelGdprErasure.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .delete("/me/delete-account")
      .expect(200);

    expect(res.body.message).toMatch(/cancelled/);
    expect(mockCancelErasureRequest).toHaveBeenCalledWith("user-123");
    expect(mockCancelGdprErasure).toHaveBeenCalledWith("user-123");
  });

  it("returns 404 when no self-initiated pending request exists", async () => {
    mockFindPendingSelfErasureRequest.mockResolvedValueOnce(null);

    await request(app)
      .delete("/me/delete-account")
      .expect(404);

    expect(mockCancelErasureRequest).not.toHaveBeenCalled();
  });

  it("returns 404 when only an admin-initiated request exists (not cancellable by user)", async () => {
    // findPendingSelfErasureRequest excludes admin_id IS NOT NULL rows
    mockFindPendingSelfErasureRequest.mockResolvedValueOnce(null);

    await request(app)
      .delete("/me/delete-account")
      .expect(404);

    expect(mockCancelErasureRequest).not.toHaveBeenCalled();
  });
});
