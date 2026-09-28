import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../middleware/error";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("../db/index", () => ({
  query: mocks.dbQuery,
  pool: { connect: vi.fn() },
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  waitlistLimiter: (_req: any, _res: any, next: any) => next(),
}));

import waitlistRouter from "./waitlist";

const app = express();
app.use(express.json());
app.use("/waitlist", waitlistRouter);
app.use(errorHandler);

describe("POST /waitlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 on successful signup", async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/waitlist")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: "You're on the list!" });
    expect(mocks.dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (email) DO NOTHING"),
      ["test@example.com", null]
    );
  });

  it("returns 201 even for a duplicate email (idempotent, no second row inserted)", async () => {
    // ON CONFLICT DO NOTHING means the INSERT is a no-op; same 201 response
    mocks.dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/waitlist")
      .send({ email: "duplicate@example.com" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: "You're on the list!" });
    expect(mocks.dbQuery).toHaveBeenCalledTimes(1);
  });

  it("accepts optional referral_code", async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/waitlist")
      .send({ email: "ref@example.com", referral_code: "FRIENDS10" });

    expect(res.status).toBe(201);
    expect(mocks.dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (email) DO NOTHING"),
      ["ref@example.com", "FRIENDS10"]
    );
  });

  it("returns 422 for an invalid email", async () => {
    const res = await request(app)
      .post("/waitlist")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_EMAIL");
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });

  it("returns 422 for an email over 254 characters", async () => {
    const longEmail = `${"a".repeat(250)}@example.com`;
    expect(longEmail.length).toBeGreaterThan(254);

    const res = await request(app)
      .post("/waitlist")
      .send({ email: longEmail });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_EMAIL");
  });

  it("returns 429 when the rate limiter blocks the request", async () => {
    const blockedApp = express();
    blockedApp.use(express.json());

    vi.resetModules();
    vi.doMock("../middleware/rate-limit", () => ({
      apiLimiter: (_req: any, _res: any, next: any) => next(),
      waitlistLimiter: (_req: any, res: any) =>
        res.status(429).json({ error: "Too many signup attempts, please try again later" }),
    }));
    vi.doMock("../db/index", () => ({
      query: mocks.dbQuery,
      pool: { connect: vi.fn() },
    }));

    const { default: blockedWaitlistRouter } = await import("./waitlist");
    blockedApp.use("/waitlist", blockedWaitlistRouter);
    blockedApp.use(errorHandler);

    const res = await request(blockedApp)
      .post("/waitlist")
      .send({ email: "rate@example.com" });

    expect(res.status).toBe(429);
  });
});
