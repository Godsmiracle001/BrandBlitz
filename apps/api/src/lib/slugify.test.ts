import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases input", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips diacritical marks", () => {
    expect(slugify("café")).toBe("cafe");
    expect(slugify("naïve")).toBe("naive");
    expect(slugify("ürüm")).toBe("urum");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(slugify("hello_world!")).toBe("hello-world");
    expect(slugify("foo@bar.com")).toBe("foo-bar-com");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("a---b")).toBe("a-b");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("-hello-")).toBe("hello");
    expect(slugify("--test--")).toBe("test");
  });

  it("truncates to 24 characters", () => {
    const long = "a".repeat(50);
    expect(slugify(long)).toHaveLength(24);
    expect(slugify(long)).toBe("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("handles numbers", () => {
    expect(slugify("user123")).toBe("user123");
  });

  it("handles unicode beyond diacriticals", () => {
    expect(slugify("日本語")).toBe("");
  });

  it("matches the original slugifyUsername behavior", () => {
    // Reproduces the exact output of the former inline function
    expect(slugify("Alice")).toBe("alice");
    expect(slugify("Bob Builder")).toBe("bob-builder");
    expect(slugify("  spaces  ")).toBe("spaces");
    expect(slugify("special!@#$chars")).toBe("special-chars");
  });
});
