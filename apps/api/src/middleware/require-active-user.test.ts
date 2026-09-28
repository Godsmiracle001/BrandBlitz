import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../db/queries/users", () => ({ findUserById: vi.fn() }));
vi.mock("./error", () => ({
  createError: (message: string, statusCode: number, code?: string) =>
    Object.assign(new Error(message), { statusCode, code }),
}));

import { requireActiveUser } from "./require-active-user";
import { findUserById } from "../db/queries/users";

const mockFindUserById = vi.mocked(findUserById);
const res = {} as Response;
const next = vi.fn() as unknown as NextFunction;

function makeReq(sub?: string): Partial<Request> {
  return { user: sub ? { sub } : undefined } as any;
}

describe("requireActiveUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 401 when req.user is absent", async () => {
    await expect(requireActiveUser(makeReq() as Request, res, next)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("throws 404 when user is not found in DB", async () => {
    mockFindUserById.mockResolvedValue(null);
    await expect(requireActiveUser(makeReq("uid") as Request, res, next)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("calls next() for an active user with suspended_at = null", async () => {
    mockFindUserById.mockResolvedValue({ status: "active", suspended_at: null } as any);
    await requireActiveUser(makeReq("uid") as Request, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("throws 403 ACCOUNT_SUSPENDED when suspended_at is non-null", async () => {
    mockFindUserById.mockResolvedValue({
      status: "suspended",
      suspended_at: "2025-01-01T00:00:00Z",
    } as any);
    await expect(requireActiveUser(makeReq("uid") as Request, res, next)).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_SUSPENDED",
    });
  });

  it("throws 403 ACCOUNT_SUSPENDED when status=suspended even if suspended_at=null", async () => {
    mockFindUserById.mockResolvedValue({ status: "suspended", suspended_at: null } as any);
    await expect(requireActiveUser(makeReq("uid") as Request, res, next)).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_SUSPENDED",
    });
  });
});
