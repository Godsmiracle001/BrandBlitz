import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Challenge } from "../db/queries/challenges";
import type { LeaderboardSession } from "../db/queries/sessions";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getChallengeById: vi.fn(),
  updateChallengeStatus: vi.fn(),
  getLeaderboard: vi.fn(),
  createPayout: vi.fn(),
  updatePayoutStatus: vi.fn(),
  incrementUserEarnings: vi.fn(),
  queueReferralBonusForPayout: vi.fn(),
  submitBatchPayout: vi.fn(),
  isRetriableStellarError: vi.fn(),
  isInsufficientFeeError: vi.fn(),
  queueAdd: vi.fn(),
  enqueueLeaderboardRefresh: vi.fn(),
  emitCounterMetric: vi.fn(),
  verifySessionHmac: vi.fn().mockReturnValue(true),
  metricsInc: vi.fn(),
  getLicensePayoutTerms: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../db/queries/challenges", () => ({
  getChallengeById: mocks.getChallengeById,
  updateChallengeStatus: mocks.updateChallengeStatus,
}));

vi.mock("../db/queries/sessions", () => ({
  getLeaderboard: mocks.getLeaderboard,
}));

vi.mock("../db/queries/payouts", () => ({
  createPayout: mocks.createPayout,
  updatePayoutStatus: mocks.updatePayoutStatus,
}));

vi.mock("../db/queries/users", () => ({
  incrementUserEarnings: mocks.incrementUserEarnings,
}));

vi.mock("../db/queries/challenge-licenses", () => ({
  getLicensePayoutTerms: mocks.getLicensePayoutTerms,
}));

vi.mock("./referrals", () => ({
  queueReferralBonusForPayout: mocks.queueReferralBonusForPayout,
}));

vi.mock("@brandblitz/stellar", () => ({
  submitBatchPayout: mocks.submitBatchPayout,
  isRetriableStellarError: mocks.isRetriableStellarError,
  isInsufficientFeeError: mocks.isInsufficientFeeError,
  EscrowClient: vi.fn(),
}));

vi.mock("../queues/payout.queue", () => ({
  payoutQueue: {
    add: mocks.queueAdd,
  },
  payoutJobOptions: { attempts: 3 },
}));

vi.mock("../queues/leaderboard-refresh.queue", () => ({
  enqueueLeaderboardRefresh: mocks.enqueueLeaderboardRefresh,
}));

vi.mock("../lib/redis", () => ({
  redis: {},
  emitCounterMetric: mocks.emitCounterMetric,
  stellarSequenceStore: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    setIfAbsent: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: mocks.logger,
}));

vi.mock("../lib/integrity", () => ({
  verifySessionHmac: mocks.verifySessionHmac,
}));

vi.mock("../lib/metrics", () => ({
  metrics: { inc: mocks.metricsInc },
}));

import { processPayout } from "./payout";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const challengeFixture: Challenge = {
  id: "challenge-1",
  brand_id: "brand-1",
  challenge_id: "memo-1",
  pool_amount_stroops: "900000000",
  pool_amount_usdc: "90.0000000",
  status: "ended",
  stellar_deposit_tx: null,
  payout_tx_hashes: null,
  max_players: null,
  starts_at: "2026-04-24T10:00:00.000Z",
  ends_at: "2026-04-24T11:00:00.000Z",
  created_at: "2026-04-24T09:00:00.000Z",
};

function buildLeaderboardSession(
  overrides: Partial<LeaderboardSession> = {}
): LeaderboardSession {
  return {
    id: "session-1",
    user_id: "user-1",
    challenge_id: "challenge-1",
    device_id: null,
    warmup_started_at: null,
    warmup_completed_at: null,
    challenge_started_at: null,
    completed_at: "2026-04-24T10:30:00.000Z",
    round_1_answer: null,
    round_1_score: 100,
    round_2_answer: null,
    round_2_score: 100,
    round_3_answer: null,
    round_3_score: 100,
    total_score: 300,
    rank: null,
    flagged: false,
    flag_reasons: null,
    is_practice: false,
    integrity_hmac: "valid-hmac",
    created_at: "2026-04-24T10:00:00.000Z",
    username: "player@example.com",
    avatar_url: "https://example.com/avatar.png",
    display_name: "Player",
    league: "bronze",
    display_name: "Player One",
    league: null,
    total_earned_usdc: "0.0000000",
    stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("processPayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.HOT_WALLET_SECRET = "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    process.env.STELLAR_NETWORK = "testnet";

    mocks.verifySessionHmac.mockReturnValue(true);
    mocks.getChallengeById.mockResolvedValue(challengeFixture);
    mocks.createPayout.mockImplementation(async ({ userId }: { userId: string }) => ({
      id: `payout-${userId}`,
    }));
    mocks.submitBatchPayout.mockImplementation(
      async (recipients: Array<{ address: string; amount: string }>) => [
        {
          txHash: "tx-test-1",
          recipients,
          success: true,
        },
      ]
    );
    mocks.isRetriableStellarError.mockReturnValue(false);
    mocks.isInsufficientFeeError.mockReturnValue(false);
    mocks.getLicensePayoutTerms.mockResolvedValue(null);
  });

  it("builds a non-empty recipients list from ranked winners", async () => {
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-1",
        user_id: "user-1",
        total_score: 300,
        completed_at: "2026-04-24T10:10:00.000Z",
        stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      }),
      buildLeaderboardSession({
        id: "session-2",
        user_id: "user-2",
        total_score: 150,
        completed_at: "2026-04-24T10:20:00.000Z",
        stellar_address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ2",
      }),
    ]);

    await processPayout("challenge-1");

    expect(mocks.submitBatchPayout).toHaveBeenCalledTimes(1);

    const [recipients] = mocks.submitBatchPayout.mock.calls[0] as [
      Array<{ address: string; amount: string }>
    ];

    expect(recipients.length).toBeGreaterThan(0);
    expect(recipients.map((r) => r.address)).toEqual([
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ2",
    ]);
  });

  it("splits a licensed challenge fee to the licensor through the payout batch", async () => {
    mocks.getLicensePayoutTerms.mockResolvedValue({
      fee_bps: 1000,
      user_id: "licensor-user",
      stellar_address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        user_id: "winner-user",
        total_score: 300,
        stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      }),
    ]);

    await processPayout("challenge-1");

    const [recipients] = mocks.submitBatchPayout.mock.calls[0] as [
      Array<{ address: string; amount: string }>
    ];
    expect(recipients).toEqual([
      {
        address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        amount: "81.0000000",
      },
      {
        address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        amount: "9.0000000",
      },
    ]);
  });

  it("logs an error and skips winners with no Stellar address", async () => {
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-1",
        user_id: "user-no-address",
        total_score: 300,
        stellar_address: null,
      }),
      buildLeaderboardSession({
        id: "session-2",
        user_id: "user-with-address",
        total_score: 250,
        stellar_address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3",
      }),
    ]);

    await processPayout("challenge-1");

    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Winner missing Stellar address on file; skipping payout",
      expect.objectContaining({
        challengeId: "challenge-1",
        userId: "user-no-address",
      })
    );

    const [recipients] = mocks.submitBatchPayout.mock.calls[0] as [
      Array<{ address: string; amount: string }>
    ];

    expect(recipients).toHaveLength(1);
    expect(recipients[0]?.address).toBe("GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3");
  });

  it("marks a challenge settled when there are no ranked sessions", async () => {
    mocks.getChallengeById.mockResolvedValue({ ...challengeFixture, id: "challenge-2" });
    mocks.getLeaderboard.mockResolvedValue([]);

    await processPayout("challenge-2");

    expect(mocks.submitBatchPayout).not.toHaveBeenCalled();
    expect(mocks.updateChallengeStatus).toHaveBeenCalledWith("challenge-2", "settled");
  });

  it("marks payouts failed when Stellar submission fails", async () => {
    mocks.getChallengeById.mockResolvedValue({
      ...challengeFixture,
      id: "challenge-3",
      pool_amount_stroops: "200000000",
      pool_amount_usdc: "20.0000000",
    });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({ id: "session-1", user_id: "user-1", total_score: 100, stellar_address: "GUSER1" }),
      buildLeaderboardSession({ id: "session-2", user_id: "user-2", total_score: 50, stellar_address: "GUSER2" }),
    ]);
    mocks.submitBatchPayout.mockResolvedValue([
      {
        txHash: "",
        recipients: [
          { address: "GUSER1", amount: "13.3333333" },
          { address: "GUSER2", amount: "6.6666667" },
        ],
        success: false,
        error: "tx_failed",
      },
    ]);

    await processPayout("challenge-3");

    expect(mocks.updatePayoutStatus).toHaveBeenCalledWith(
      "payout-user-1",
      "failed",
      undefined,
      "tx_failed"
    );
    expect(mocks.updatePayoutStatus).toHaveBeenCalledWith(
      "payout-user-2",
      "failed",
      undefined,
      "tx_failed"
    );
    expect(mocks.updatePayoutStatus).toHaveBeenCalledWith("payout-user-1", "failed", undefined, "tx_failed");
    expect(mocks.updatePayoutStatus).toHaveBeenCalledWith("payout-user-2", "failed", undefined, "tx_failed");
    expect(mocks.updateChallengeStatus).toHaveBeenCalledWith("challenge-3", "payout_failed", undefined);
  });

  it("rethrows retriable Stellar errors so the payout worker can retry", async () => {
    const error = Object.assign(new Error("Horizon timeout"), { code: "ECONNABORTED" });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-1",
        user_id: "user-1",
        total_score: 100,
        stellar_address: "GUSER1",
      }),
    ]);
    mocks.submitBatchPayout.mockRejectedValue(error);
    mocks.isRetriableStellarError.mockReturnValue(true);

    await expect(processPayout("challenge-1")).rejects.toBe(error);

    expect(mocks.updateChallengeStatus).not.toHaveBeenCalledWith(
      "challenge-1",
      "payout_failed",
      expect.anything()
    );
  });

  it("returns early when the challenge is not in the ended state", async () => {
    mocks.getChallengeById.mockResolvedValue({ ...challengeFixture, id: "challenge-4", status: "active" });

    await processPayout("challenge-4");

    expect(mocks.getLeaderboard).not.toHaveBeenCalled();
    expect(mocks.createPayout).not.toHaveBeenCalled();
    expect(mocks.submitBatchPayout).not.toHaveBeenCalled();
    expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
  });

  it("skips recipients whose share falls below the dust threshold", async () => {
    mocks.getChallengeById.mockResolvedValue({
      ...challengeFixture,
      id: "challenge-5",
      pool_amount_stroops: "2",
      pool_amount_usdc: "0.0000002",
    });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({ id: "session-1", user_id: "user-1", total_score: 9999999, stellar_address: "GUSER1" }),
      buildLeaderboardSession({ id: "session-2", user_id: "user-2", total_score: 1, stellar_address: "GUSER2" }),
    ]);
    mocks.submitBatchPayout.mockResolvedValue([
      {
        txHash: "tx-dust",
        recipients: [{ address: "GUSER1", amount: "0.0000001" }],
        success: true,
      },
    ]);

    await processPayout("challenge-5");

    expect(mocks.createPayout).toHaveBeenCalledTimes(1);
    expect(mocks.createPayout).toHaveBeenCalledWith({
      challengeId: "challenge-5",
      userId: "user-1",
      stellarAddress: "GUSER1",
      amountStroops: 1n,
    });
    expect(mocks.submitBatchPayout).toHaveBeenCalledWith(
      [{ address: "GUSER1", amount: "0.0000001" }],
      expect.any(String),
      "challenge-5",
      "testnet",
      expect.any(Object)
    );
  });

  it("gives players with tied total scores an equal proportional payout share", async () => {
    mocks.getChallengeById.mockResolvedValue({
      ...challengeFixture,
      id: "challenge-tie",
      pool_amount_stroops: "1000000000",
      pool_amount_usdc: "100.0000000",
    });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-1",
        user_id: "user-1",
        total_score: 150,
        completed_at: "2026-04-24T10:10:00.000Z",
        stellar_address: "GUSER1",
      }),
      buildLeaderboardSession({
        id: "session-2",
        user_id: "user-2",
        total_score: 150,
        completed_at: "2026-04-24T10:20:00.000Z",
        stellar_address: "GUSER2",
      }),
    ]);

    await processPayout("challenge-tie");

    expect(mocks.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", amountStroops: 500_000_000n })
    );
    expect(mocks.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-2", amountStroops: 500_000_000n })
    );
  });

  it("aborts payout and logs critical error when a session integrity HMAC does not match", async () => {
    mocks.getChallengeById.mockResolvedValue({ ...challengeFixture, id: "challenge-6" });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-tampered",
        user_id: "user-1",
        total_score: 999,
        integrity_hmac: "invalid-hmac",
        stellar_address: "GUSER1",
      }),
    ]);
    mocks.verifySessionHmac.mockReturnValue(false);

    await expect(processPayout("challenge-6")).rejects.toThrow("session-tampered");

    expect(mocks.submitBatchPayout).not.toHaveBeenCalled();
    expect(mocks.metricsInc).toHaveBeenCalledWith("antiCheat.integrity_hmac_tampered_total");
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Session integrity check failed — payout aborted",
      expect.objectContaining({ sessionId: "session-tampered" })
    );
  });

  it("proceeds normally when all sessions pass integrity verification", async () => {
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-ok",
        user_id: "user-1",
        total_score: 300,
        integrity_hmac: "valid-hmac",
        stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      }),
    ]);
    mocks.verifySessionHmac.mockReturnValue(true);

    await processPayout("challenge-1");

    expect(mocks.submitBatchPayout).toHaveBeenCalledTimes(1);
    expect(mocks.metricsInc).not.toHaveBeenCalledWith("antiCheat.integrity_hmac_tampered_total");
  });

  it("failed payout always carries a non-empty error message from the Stellar result", async () => {
    mocks.getChallengeById.mockResolvedValue({ ...challengeFixture, id: "challenge-msg-1" });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({ id: "session-1", user_id: "user-1", total_score: 100, stellar_address: "GUSER1" }),
    ]);
    mocks.submitBatchPayout.mockResolvedValue([
      {
        txHash: "",
        recipients: [{ address: "GUSER1", amount: "90.0000000" }],
        success: false,
        error: "horizon: transaction timed out",
      },
    ]);

    await processPayout("challenge-msg-1");

    const [, status, , errorMessage] = mocks.updatePayoutStatus.mock.calls[0] as [string, string, string, string];
    expect(status).toBe("failed");
    expect(errorMessage).toBeTruthy();
    expect(errorMessage.length).toBeGreaterThan(0);
  });

  it("failed payout uses a fallback message when Stellar result carries no error field", async () => {
    mocks.getChallengeById.mockResolvedValue({ ...challengeFixture, id: "challenge-msg-2" });
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({ id: "session-1", user_id: "user-1", total_score: 100, stellar_address: "GUSER1" }),
    ]);
    mocks.submitBatchPayout.mockResolvedValue([
      {
        txHash: "",
        recipients: [{ address: "GUSER1", amount: "90.0000000" }],
        success: false,
        // no error field — service must supply a fallback
      },
    ]);

    await processPayout("challenge-msg-2");

    const [, status, , errorMessage] = mocks.updatePayoutStatus.mock.calls[0] as [string, string, string, string];
    expect(status).toBe("failed");
    expect(errorMessage).toBeTruthy();
    expect(errorMessage.length).toBeGreaterThan(0);
  });

  it("successful payout writes an empty error_message so the CHECK constraint is satisfied", async () => {
    mocks.getLeaderboard.mockResolvedValue([
      buildLeaderboardSession({
        id: "session-ok2",
        user_id: "user-1",
        total_score: 300,
        stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      }),
    ]);

    await processPayout("challenge-1");

    // updatePayoutStatus called with status "sent" and no error message (undefined → db writes "")
    const [, status, , errorMessage] = mocks.updatePayoutStatus.mock.calls[0] as [string, string, string, string | undefined];
    expect(status).toBe("sent");
    expect(errorMessage).toBeUndefined();
  });
});
