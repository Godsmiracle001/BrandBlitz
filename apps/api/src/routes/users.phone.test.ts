import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendVerificationCodeMock,
  checkVerificationCodeMock,
  findUserByIdMock,
  findUserByPhoneHashMock,
  markPhoneVerifiedMock,
  updateUserWalletMock,
  redisState,
  redisMock,
} = vi.hoisted(() => {
  const redisState = new Map<string, string>();
  return {
    sendVerificationCodeMock: vi.fn(),
    checkVerificationCodeMock: vi.fn(),
    findUserByIdMock: vi.fn(),
    findUserByPhoneHashMock: vi.fn(),
    markPhoneVerifiedMock: vi.fn(),
    updateUserWalletMock: vi.fn(),
    redisState,
    redisMock: {
      incr: vi.fn(async (key: string) => {
        const next = Number(redisState.get(key) ?? "0") + 1;
        redisState.set(key, next.toString());
        return next;
      }),
      expire: vi.fn(async () => 1),
      get: vi.fn(async (key: string) => redisState.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        redisState.set(key, value);
        return "OK";
      }),
      del: vi.fn(async (key: string) => {
        const existed = redisState.delete(key);
        return existed ? 1 : 0;
      }),
    },
  };
});

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: vi.fn() },
          verificationChecks: { create: vi.fn() },
        })),
      },
    },
  })),
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { sub: "user-1", email: "player@example.com", iat: 0, exp: 0 };
    next();
  },
}));

vi.mock("../db/queries/users", () => ({
  findUserById: findUserByIdMock,
  findUserByPhoneHash: findUserByPhoneHashMock,
  markPhoneVerified: markPhoneVerifiedMock,
  updateUserWallet: updateUserWalletMock,
}));

vi.mock("../lib/redis", () => ({
  redis: redisMock,
}));

vi.mock("../services/phone", async () => {
  const actual = await vi.importActual<typeof import("../services/phone")>("../services/phone");
  return {
    ...actual,
    sendVerificationCode: sendVerificationCodeMock,
    checkVerificationCode: checkVerificationCodeMock,
  };
});

import { errorHandler } from "../middleware/error";
import { hashPhoneNumber } from "../services/phone";
import usersRouter from "./users";

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use("/users", usersRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe("users phone verification flow", () => {
  let currentServer: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (currentServer) {
        currentServer.close(() => resolve());
        currentServer = undefined;
        return;
      }
      resolve();
    });
  });

  beforeEach(() => {
    redisState.clear();
    vi.clearAllMocks();
    process.env.PHONE_HASH_SALT = "integration-test-phone-salt";

    sendVerificationCodeMock.mockResolvedValue(undefined);
    checkVerificationCodeMock.mockResolvedValue(true);
    findUserByIdMock.mockResolvedValue({ id: "user-1" });
    findUserByPhoneHashMock.mockResolvedValue(null);
    markPhoneVerifiedMock.mockResolvedValue(undefined);
    updateUserWalletMock.mockResolvedValue(undefined);
  });

  it("sends a code, verifies it, and persists the hashed phone", async () => {
    const { server, baseUrl } = await startServer();
    currentServer = server;

    const phone = "1 (555) 123-4567";
    const expectedHash = hashPhoneNumber(phone);

    const sendResponse = await fetch(`${baseUrl}/users/me/phone/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });

    expect(sendResponse.status).toBe(200);
    expect(sendVerificationCodeMock).toHaveBeenCalledWith("+15551234567");

    const verifyResponse = await fetch(`${baseUrl}/users/me/phone/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code: "123456" }),
    });

    expect(verifyResponse.status).toBe(200);
    expect(checkVerificationCodeMock).toHaveBeenCalledWith("+15551234567", "123456");
    expect(findUserByPhoneHashMock).toHaveBeenCalledWith(expectedHash);
    expect(markPhoneVerifiedMock).toHaveBeenCalledWith("user-1", expectedHash);
    expect(redisMock.set).toHaveBeenCalledWith(
      `phone:hash:${expectedHash}`,
      "user-1",
      "EX",
      86400 * 365
    );
  });
});
