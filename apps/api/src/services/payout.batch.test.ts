import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getChallengeById: vi.fn(),
  updateChallengeStatus: vi.fn(),
  getLeaderboard: vi.fn(),
  createPayout: vi.fn(),
  updatePayoutStatus: vi.fn(),
  submitBatchPayout: vi.fn(),
  verifySessionHmac: vi.fn().mockReturnValue(true),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metricsInc: vi.fn(),
  getLicensePayoutTerms: vi.fn(),
}));

vi.mock("../db", () => ({ query: mocks.query }));
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
vi.mock("@brandblitz/stellar", () => ({
  submitBatchPayout: mocks.submitBatchPayout,
  isRetriableStellarError: vi.fn().mockReturnValue(false),
}));
vi.mock("../lib/integrity", () => ({
  verifySessionHmac: mocks.verifySessionHmac,
}));
vi.mock("../lib/logger", () => ({ logger: mocks.logger }));
vi.mock("../lib/metrics", () => ({ metrics: { inc: mocks.metricsInc } }));
vi.mock("../lib/redis", () => ({
  stellarSequenceStore: { get: vi.fn(), set: vi.fn(), del: vi.fn(), incr: vi.fn(), setIfAbsent: vi.fn() },
}));
vi.mock("../queues/leaderboard-refresh.queue", () => ({
  enqueueLeaderboardRefresh: vi.fn(),
}));
vi.mock("./referrals", () => ({
  queueReferralBonusForPayout: vi.fn(),
}));
vi.mock("../db/queries/users", () => ({
  incrementUserEarnings: vi.fn(),
}));
vi.mock("../db/queries/challenge-licenses", () => ({
  getLicensePayoutTerms: mocks.getLicensePayoutTerms,
}));

import { processPayout } from "./payout";

describe("processPayout - batch query optimization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOT_WALLET_SECRET = "STEST";
    process.env.STELLAR_NETWORK = "testnet";

    mocks.getChallengeById.mockResolvedValue({
      id: "challenge-1",
      status: "ended",
      pool_amount_stroops: "1000000000",
      pool_amount_usdc: "100.0000000",
    });
    mocks.getLicensePayoutTerms.mockResolvedValue(null);

    mocks.createPayout.mockImplementation(async ({ userId }) => ({
      id: `payout-${userId}`,
    }));

    mocks.submitBatchPayout.mockResolvedValue([
      { txHash: "tx-test", recipients: [], success: true },
    ]);
  });

  it("processes 10 payouts with exactly 1-2 database queries (not 10+)", async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      id: `session-${i}`,
      user_id: `user-${i}`,
      challenge_id: "challenge-1",
      total_score: 100,
      completed_at: "2026-04-24T10:30:00.000Z",
      integrity_hmac: "valid",
      stellar_address: `GADDR${i}`,
      device_id: null,
      warmup_started_at: null,
      warmup_completed_at: null,
      challenge_started_at: null,
      round_1_answer: null,
      round_1_score: 100,
      round_2_answer: null,
      round_2_score: 0,
      round_3_answer: null,
      round_3_score: 0,
      rank: null,
      flagged: false,
      flag_reasons: null,
      is_practice: false,
      created_at: "2026-04-24T10:00:00.000Z",
      username: `user${i}@example.com`,
      avatar_url: null,
      display_name: `User ${i}`,
      league: null,
      total_earned_usdc: "0.0000000",
    }));

    mocks.getLeaderboard.mockResolvedValue(sessions);

    await processPayout("challenge-1");

    // getLeaderboard is 1 query, createPayout is 10 inserts but should be batched in production
    // The critical assertion: we do NOT issue 10+ individual SELECTs for user wallet addresses
    const selectCalls = mocks.query.mock.calls.filter((call) =>
      String(call[0]).toUpperCase().startsWith("SELECT")
    );

    // Should be ≤2 SELECT calls (getLeaderboard + maybe one batch user fetch)
    expect(selectCalls.length).toBeLessThanOrEqual(2);
    expect(mocks.submitBatchPayout).toHaveBeenCalledTimes(1);
  });
});
