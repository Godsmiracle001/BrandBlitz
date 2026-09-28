import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrandKitForm } from "./brand-kit-form";
import * as apiModule from "@/lib/api";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  post: vi.fn(),
  productUploadCount: 0,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
  }),
}));

// Mock the API client
vi.mock("@/lib/api", () => ({
  createApiClient: vi.fn(),
}));

// Mock the upload field
vi.mock("./upload-field", () => ({
  UploadField: ({ label, onUploaded }: any) => (
    <button type="button" onClick={() => onUploaded("test-logo-key", "https://cdn.example.com/logo.png")}>
      {label}
    </button>
  ),
}));

describe("BrandKitForm", () => {
  let mockApiClient: any;

  beforeEach(() => {
    mocks.push.mockReset();

    mockApiClient = {
      post: vi.fn(),
    };
    vi.mocked(apiModule.createApiClient).mockReturnValue(mockApiClient);
  });

  it("should redirect to /brand/[id] without query params containing secrets", async () => {
    vi.useRealTimers();

    // Mock successful API responses
    mockApiClient.post.mockImplementation((endpoint: string) => {
      if (endpoint === "/brands") {
        return Promise.resolve({
          data: {
            brand: { id: "brand-123" },
          },
        });
      }
      if (endpoint === "/brands/challenges") {
        return Promise.resolve({
          data: {
            depositInstructions: {
              hotWalletAddress: "GHOTWALLETADDRESS",
              memo: "challenge-uuid-123",
              amount: "100.00",
            },
          },
        });
      }
      return Promise.reject(new Error("Unknown endpoint"));
    });

    render(<BrandKitForm apiToken="test-token" />);

    // Fill in required fields
    fireEvent.change(screen.getByLabelText(/Brand Name/i), {
      target: { value: "Test Brand" },
    });
    fireEvent.change(screen.getByLabelText(/Prize Pool/i), {
      target: { value: "100" },
    });

    // Upload logo
    fireEvent.click(screen.getByText("Upload Brand Logo"));

    // Submit form
    fireEvent.click(screen.getByRole("button", { name: /Create Brand Kit/i }));

    // Wait for redirect
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalled();
    });

    // Verify redirect URL does NOT contain secrets
    const redirectUrl = mocks.push.mock.calls[0][0];
    expect(redirectUrl).toBe("/brand/brand-123");
    expect(redirectUrl).not.toContain("depositAddress");
    expect(redirectUrl).not.toContain("memo");
    expect(redirectUrl).not.toContain("amount");
    expect(redirectUrl).not.toContain("GHOTWALLETADDRESS");
    expect(redirectUrl).not.toContain("challenge-uuid-123");
    expect(redirectUrl).not.toContain("100.00");
  });
});
