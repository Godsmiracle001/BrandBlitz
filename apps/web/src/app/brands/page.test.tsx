import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BrandsPage from "./page";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
  },
}));

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const mockBrands = [
  {
    id: "b-1",
    name: "Acme Corp",
    tagline: "Building the future",
    logo_url: "https://example.com/acme.png",
    primary_color: "#ff0000",
    category: "Tech",
    active_challenge_count: 2,
  },
  {
    id: "b-2",
    name: "Beta Inc",
    tagline: "Second to none",
    logo_url: null,
    primary_color: "#00ff00",
    category: "Finance",
    active_challenge_count: 0,
  },
];

describe("BrandsPage", () => {
  it("renders brands and sets title/aria-label for used vs unused alphabet filter buttons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ brands: mockBrands }),
      })
    );

    const jsx = await BrandsPage();
    render(jsx);

    expect(screen.getByText("Brand Directory")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("Beta Inc")).toBeInTheDocument();

    // Button 'A' is used
    const buttonA = screen.getByRole("button", { name: "Jump to brands starting with A" });
    expect(buttonA).toBeEnabled();
    expect(buttonA).toHaveAttribute("title", "Jump to brands starting with A");

    // Button 'Z' is disabled because no brands start with Z
    const buttonZ = screen.getByRole("button", { name: "No brands starting with Z" });
    expect(buttonZ).toBeDisabled();
    expect(buttonZ).toHaveAttribute("title", "No brands starting with Z");
  });
});
