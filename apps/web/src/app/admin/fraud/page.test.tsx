import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminFraudPage from "./page";

const { apiGetMock, apiPatchMock, pushMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
  pushMock: vi.fn(),
}));

const adminSessionData = {
  apiToken: "admin-test-token",
  user: {
    role: "admin",
  },
};

const routerMock = {
  push: pushMock,
};

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: adminSessionData,
    status: "authenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");

  return {
    ...actual,
    createApiClient: () => ({
      get: apiGetMock,
      patch: apiPatchMock,
    }),
  };
});

describe("AdminFraudPage - Resolution Reason Guidance", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    pushMock.mockReset();

    apiGetMock.mockResolvedValue({
      data: {
        flags: [
          {
            id: "flag-1",
            sessionId: "session-1",
            userId: "user-1",
            userDisplayName: "Test User",
            userEmail: "test@example.com",
            challengeId: "challenge-1",
            flagType: "reaction_time_bot_threshold",
            details: { reactionTimeMs: 40 },
            status: "open",
            resolutionReason: null,
            resolvedAt: null,
            createdAt: "2026-09-24T12:00:00.000Z",
            reactionTimes: {
              round1Ms: 40,
              round2Ms: null,
              round3Ms: null,
            },
            sessionFlagReasons: null,
            deviceId: "device-1",
          },
        ],
        pagination: {
          pageSize: 20,
          nextCursor: null,
        },
      },
    });
  });

  it("displays live character counter in resolution dialog and preserves required-reason validation", async () => {
    const user = userEvent.setup();
    render(<AdminFraudPage />);

    await waitFor(() => {
      expect(screen.getByText("reaction_time_bot_threshold")).toBeInTheDocument();
    });

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    await user.click(resolveButton);

    expect(screen.getByText("Resolution reason")).toBeInTheDocument();
    expect(screen.getByText("0/500")).toBeInTheDocument();

    const submitButton = screen.getByRole("button", { name: "Mark resolved" });
    expect(submitButton).toBeDisabled();

    const reasonInput = screen.getByLabelText(/Resolution reason/);
    await user.type(reasonInput, "Legitimate player verified through video replay review");

    expect(
      screen.getByText(`${"Legitimate player verified through video replay review".length}/500`)
    ).toBeInTheDocument();
    expect(submitButton).toBeEnabled();
  });

  it("applies warning style at 85% limit and error style at max length", async () => {
    const user = userEvent.setup();
    render(<AdminFraudPage />);

    await waitFor(() => {
      expect(screen.getByText("reaction_time_bot_threshold")).toBeInTheDocument();
    });

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    await user.click(resolveButton);

    const reasonInput = screen.getByLabelText(/Resolution reason/);

    const text425 = "a".repeat(425);
    await user.type(reasonInput, text425);

    const counter = screen.getByText("425/500");
    expect(counter).toHaveClass("text-amber-600");

    const extra75 = "b".repeat(75);
    await user.type(reasonInput, extra75);

    const maxCounter = screen.getByText("500/500");
    expect(maxCounter).toHaveClass("text-red-600");
  });
});
