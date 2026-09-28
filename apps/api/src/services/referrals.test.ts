import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  findReferralByReferredId: vi.fn(),
  findUserById: vi.fn(),
  createReferralPayout: vi.fn(),
  enqueueReferralBonus: vi.fn(),
  getSession: vi.fn(),
  markReferralRewarded: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mocks.query,
}));

vi.mock("../db/queries/referrals", () => ({
  createReferral: vi.fn(),
  countReferralConversions: vi.fn(),
  countReferralInvites: vi.fn(),
  findReferralByReferrerAndReferred: vi.fn(),
  findReferralByReferredId: mocks.findReferralByReferredId,
  markReferralRewarded: mocks.markReferralRewarded,
}));

vi.mock("../db/queries/users", () => ({
  findUserById: mocks.findUserById,
  findUserByReferralCode: vi.fn(),
  getUserReferralCode: vi.fn(),
  setUserReferralCode: vi.fn(),
}));

vi.mock("../db/queries/referral-payouts", () => ({
  createReferralPayout: mocks.createReferralPayout,
  getReferralPayoutTotalsForUser: vi.fn(),
}));

vi.mock("../db/queries/sessions", () => ({
  getSession: mocks.getSession,
}));

vi.mock("../queues/referral-bonus.queue", () => ({
  enqueueReferralBonus: mocks.enqueueReferralBonus,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("../middleware/error", () => ({
  createError: (message: string, statusCode: number) =>
    Object.assign(new Error(message), { statusCode }),
}));

import { queueReferralBonusForPayout } from "./referrals";

describe("queueReferralBonusForPayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findReferralByReferredId.mockResolvedValue({
      id: "referral-1",
      referrer_id: "referrer-1",
      referred_id: "referred-1",
      rewarded: false,
    });
    mocks.findUserById.mockImplementation((userId: string) =>
      Promise.resolve({
        id: userId,
        stellar_address: `${userId}-stellar`,
        embedded_wallet_address: null,
      })
    );
    mocks.getSession.mockResolvedValue({ id: "session-1" });
    mocks.createReferralPayout.mockResolvedValue({
      id: "payout-1",
      status: "pending",
    });
  });

  it("skips enqueue and writes audit log when the referred session has fraud flags", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ exists: true }] }).mockResolvedValueOnce({
      rows: [],
    });

    await queueReferralBonusForPayout({
      referredUserId: "referred-1",
      challengeId: "challenge-1",
      referralWinAmountStroops: 100_000_000n,
    });

    expect(mocks.createReferralPayout).not.toHaveBeenCalled();
    expect(mocks.enqueueReferralBonus).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("referral_bonus_skipped"),
      expect.arrayContaining([
        "session-1",
        expect.objectContaining({
          sessionId: "session-1",
          referrerId: "referrer-1",
          referredId: "referred-1",
          reason: "fraud_flag",
        }),
      ])
    );
  });

  it("enqueues the referral bonus when the referred session has no fraud flags", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ exists: false }] });

    await queueReferralBonusForPayout({
      referredUserId: "referred-1",
      challengeId: "challenge-1",
      referralWinAmountStroops: 100_000_000n,
    });

    expect(mocks.createReferralPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        referralId: "referral-1",
        referrerId: "referrer-1",
        referredId: "referred-1",
      })
    );
    expect(mocks.markReferralRewarded).toHaveBeenCalledWith("referral-1");
    expect(mocks.enqueueReferralBonus).toHaveBeenCalledWith("payout-1");
  });

  it("does not insert a duplicate payout or enqueue a second job when the referral is already rewarded", async () => {
    mocks.findReferralByReferredId.mockResolvedValue({
      id: "referral-1",
      referrer_id: "referrer-1",
      referred_id: "referred-1",
      rewarded: true,
    });

    await queueReferralBonusForPayout({
      referredUserId: "referred-1",
      challengeId: "challenge-1",
      referralWinAmountStroops: 100_000_000n,
    });

    expect(mocks.createReferralPayout).not.toHaveBeenCalled();
    expect(mocks.enqueueReferralBonus).not.toHaveBeenCalled();
    expect(mocks.markReferralRewarded).not.toHaveBeenCalled();
  });

  it("does not write a bonus when the referred user has no referral on record (no qualifying action)", async () => {
    mocks.findReferralByReferredId.mockResolvedValue(null);

    await queueReferralBonusForPayout({
      referredUserId: "referred-1",
      challengeId: "challenge-1",
      referralWinAmountStroops: 100_000_000n,
    });

    expect(mocks.createReferralPayout).not.toHaveBeenCalled();
    expect(mocks.enqueueReferralBonus).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("second trigger for the same referrer/referred pair is a no-op once the first has already enqueued a payout", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ exists: false }] });

    await queueReferralBonusForPayout({
      referredUserId: "referred-1",
      challengeId: "challenge-1",
      referralWinAmountStroops: 100_000_000n,
    });

    expect(mocks.enqueueReferralBonus).toHaveBeenCalledTimes(1);

    mocks.findReferralByReferredId.mockResolvedValue({
      id: "referral-1",
      referrer_id: "referrer-1",
      referred_id: "referred-1",
      rewarded: true,
    });

    await queueReferralBonusForPayout({
      referredUserId: "referred-1",
      challengeId: "challenge-1",
      referralWinAmountStroops: 100_000_000n,
    });

    expect(mocks.createReferralPayout).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueReferralBonus).toHaveBeenCalledTimes(1);
  });
});
