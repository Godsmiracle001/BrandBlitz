import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ createApiClient: () => ({ get }) }));

import BrandDirectoryPage from "./page";

describe("BrandDirectoryPage", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({
      data: {
        data: [
          { id: "c1", brand_id: "b1", brand_name: "Acme" },
          { id: "c2", brand_id: "b2", brand_name: "Brightside" },
        ],
        nextCursor: null,
      },
    });
  });

  it("explains when search and letter filters have no results and can clear both", async () => {
    render(<BrandDirectoryPage />);
    await screen.findByText("Acme");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search brands" }), {
      target: { value: "Bright" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Brands starting with A" }));

    expect(
      await screen.findByText(
        "No brands match both filters. Clear the search, the letter filter, or both."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Acme")).toBeTruthy();
  });

  it("keeps search-only empty guidance distinct", async () => {
    render(<BrandDirectoryPage />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search brands" }), {
      target: { value: "Missing" },
    });
    expect(await screen.findByText("Try a different search term.")).toBeTruthy();
  });
});
