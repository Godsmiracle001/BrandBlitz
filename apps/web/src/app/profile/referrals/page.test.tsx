import "@testing-library/jest-dom/vitest";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReferralsPage from "./page";

const { apiGetMock, pushMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  pushMock: vi.fn(),
}));

const sessionData = {
  apiToken: "test-token",
};

const routerMock = {
  push: pushMock,
};

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === "string" ? href : undefined} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt, src, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) => (
    <img alt={alt} src={src} {...props} />
  ),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: sessionData,
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
    }),
  };
});

describe("ReferralsPage", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    pushMock.mockReset();
  });

  it("renders a skeleton layout while data is loading", () => {
    apiGetMock.mockReturnValue(new Promise(() => {}));

    const { container } = render(<ReferralsPage />);

    const skeletons = container.querySelectorAll(".skeleton-shimmer");
    expect(skeletons.length).toBeGreaterThan(0);
    expect(screen.queryByText("Loading referral data...")).not.toBeInTheDocument();
  });

  it("renders a failure empty state with a Try Again button when fetch fails", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("network error"));

    render(<ReferralsPage />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load referral hub")).toBeInTheDocument();
    });

    const retryButton = screen.getByRole("button", { name: "Try Again" });
    expect(retryButton).toBeInTheDocument();
  });

  it("re-runs referral fetch when Try Again is clicked", async () => {
    const user = userEvent.setup();
    apiGetMock.mockRejectedValueOnce(new Error("temporary error"));

    render(<ReferralsPage />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load referral hub")).toBeInTheDocument();
    });

    apiGetMock.mockResolvedValueOnce({
      data: {
        referralCode: "REF-TEST123",
        referredUsers: [],
        bonusStatus: {
          pendingUsdc: "10.00",
          confirmedUsdc: "25.00",
        },
      },
    });

    const retryButton = screen.getByRole("button", { name: "Try Again" });
    await user.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText("Referral Hub")).toBeInTheDocument();
      expect(screen.getByText("REF-TEST123")).toBeInTheDocument();
    });

    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("renders referral data properly on success", async () => {
    apiGetMock.mockResolvedValueOnce({
      data: {
        referralCode: "REF-TEST123",
        referredUsers: [
          {
            id: "user-1",
            username: "alex",
            displayName: "Alex",
            avatarUrl: null,
            joinedAt: "2026-01-15T00:00:00.000Z",
            bonusPaid: true,
          },
        ],
        bonusStatus: {
          pendingUsdc: "5.00",
          confirmedUsdc: "15.00",
        },
      },
    });

    render(<ReferralsPage />);

    await waitFor(() => {
      expect(screen.getByText("Referral Hub")).toBeInTheDocument();
      expect(screen.getByText("REF-TEST123")).toBeInTheDocument();
      expect(screen.getByText("@alex")).toBeInTheDocument();
      expect(screen.getByText("Bonus Paid")).toBeInTheDocument();
    });
  });
});
