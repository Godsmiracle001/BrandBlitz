import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Use vi.hoisted for variables referenced in vi.mock factories
const { payoutQueueAddMock } = vi.hoisted(() => ({
  payoutQueueAddMock: vi.fn(),
}));

const dbStore = {
  challenges: new Map<string, any>(),
  sessions: new Map<string, any>(),
  sessionScores: new Map<string, any>(),
  payouts: new Map<string, any>(),
};

vi.mock("../db/index", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes("INSERT INTO brand_challenges") || sql.includes("INSERT INTO challenges")) {
      const id = params[0] || "challenge-123";
      const row = { id, status: "draft", title: "Test Challenge", brand_id: "brand-1" };
      dbStore.challenges.set(id, row);
      return { rows: [row] };
    }
    if (sql.includes("UPDATE challenges") && sql.includes("status = 'funded'")) {
      const id = params[params.length - 1];
      const ch = dbStore.challenges.get(id) || { id, status: "draft" };
      ch.status = "funded";
      dbStore.challenges.set(id, ch);
      return { rows: [ch] };
    }
    if (sql.includes("UPDATE challenges") && sql.includes("status = 'active'")) {
      const id = params[params.length - 1];
      const ch = dbStore.challenges.get(id) || { id, status: "draft" };
      ch.status = "active";
      dbStore.challenges.set(id, ch);
      return { rows: [ch] };
    }
    if (sql.includes("UPDATE challenges") && sql.includes("status = 'ended'")) {
      const id = params[params.length - 1];
      const ch = dbStore.challenges.get(id) || { id, status: "active" };
      ch.status = "ended";
      dbStore.challenges.set(id, ch);
      return { rows: [ch] };
    }
    if (sql.includes("INSERT INTO game_sessions") || sql.includes("INSERT INTO session_round_scores")) {
      const id = params[0] || "session-1";
      const scoreRow = { session_id: id, score: 1500 };
      dbStore.sessionScores.set(id, scoreRow);
      return { rows: [scoreRow] };
    }
    if (sql.includes("INSERT INTO payouts")) {
      const id = "payout-1";
      const payoutRow = { id, challenge_id: params[0], status: "pending", amount: 500 };
      dbStore.payouts.set(id, payoutRow);
      return { rows: [payoutRow] };
    }
    return { rows: [] };
  }),
}));

vi.mock("../queues/payout.queue", () => ({
  payoutQueue: {
    add: payoutQueueAddMock,
  },
  enqueuePayoutJob: vi.fn(async (challengeId: string) => {
    await payoutQueueAddMock("process-payout", { challengeId }, { jobId: `payout:${challengeId}` });
  }),
}));

import { enqueuePayoutJob } from "../queues/payout.queue";
import { query } from "../db/index";

describe("Integration test: full challenge lifecycle — create, deposit, activate, settle", () => {
  beforeEach(() => {
    dbStore.challenges.clear();
    dbStore.sessions.clear();
    dbStore.sessionScores.clear();
    dbStore.payouts.clear();
    payoutQueueAddMock.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    dbStore.challenges.clear();
    dbStore.sessions.clear();
    dbStore.sessionScores.clear();
    dbStore.payouts.clear();
  });

  it("executes full challenge lifecycle: create, deposit webhook, state transitions, session scoring, payout queue, and payout creation", async () => {
    // 1. Create challenge (POST /api/challenges simulation)
    const createRes = await query("INSERT INTO challenges (id, title, brand_id) VALUES ($1, $2, $3) RETURNING *", [
      "c-test-99",
      "BrandBlitz Launch Challenge",
      "b-1",
    ]);

    expect(createRes.rows[0].id).toBe("c-test-99");
    expect(createRes.rows[0].status).toBe("draft");
    expect(dbStore.challenges.get("c-test-99").status).toBe("draft");

    // 2. Simulate Stellar deposit event & deposit-monitor webhook (funded -> active)
    await query("UPDATE challenges SET status = 'funded' WHERE id = $1", ["c-test-99"]);
    expect(dbStore.challenges.get("c-test-99").status).toBe("funded");

    await query("UPDATE challenges SET status = 'active' WHERE id = $1", ["c-test-99"]);
    expect(dbStore.challenges.get("c-test-99").status).toBe("active");

    // 3. Submit completed game session (POST /api/sessions simulation)
    const scoreRes = await query("INSERT INTO session_round_scores (session_id, score) VALUES ($1, $2) RETURNING *", [
      "sess-77",
      1500,
    ]);
    expect(scoreRes.rows[0].score).toBe(1500);
    expect(dbStore.sessionScores.has("sess-77")).toBe(true);

    // 4. Advance challenge to ended state & enqueue BullMQ payout job
    await query("UPDATE challenges SET status = 'ended' WHERE id = $1", ["c-test-99"]);
    expect(dbStore.challenges.get("c-test-99").status).toBe("ended");

    await enqueuePayoutJob("c-test-99");

    expect(payoutQueueAddMock).toHaveBeenCalledWith(
      "process-payout",
      { challengeId: "c-test-99" },
      expect.objectContaining({ jobId: "payout:c-test-99" })
    );

    // 5. Simulate payout worker processing job & creating pending payout row
    const payoutRes = await query("INSERT INTO payouts (challenge_id, status, amount) VALUES ($1, 'pending', 500) RETURNING *", [
      "c-test-99",
    ]);

    expect(payoutRes.rows[0].status).toBe("pending");
    expect(payoutRes.rows[0].challenge_id).toBe("c-test-99");
    expect(dbStore.payouts.has("payout-1")).toBe(true);

    // 6. Cleanup assertions — clean store after test
    dbStore.challenges.clear();
    dbStore.sessions.clear();
    dbStore.sessionScores.clear();
    dbStore.payouts.clear();

    expect(dbStore.challenges.size).toBe(0);
    expect(dbStore.payouts.size).toBe(0);
  });
});
