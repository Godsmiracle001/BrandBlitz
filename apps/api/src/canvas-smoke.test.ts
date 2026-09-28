import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";

/**
 * Issue #1182: @napi-rs/canvas is a pre-1.0 native-binding dependency, where
 * a semver minor bump (0.x.y -> 0.x+1.0) can carry breaking API/ABI changes
 * without npm/dependabot classifying it as "major." This test exercises the
 * real native rendering pipeline — canvas creation, 2D context drawing, and
 * PNG encoding — so a broken native binding (wrong prebuilt binary, changed
 * API surface, a corrupted encode) fails CI instead of silently shipping.
 *
 * Not currently wired into a real feature in apps/api/src — this is a
 * standalone regression guard on the dependency itself.
 */
describe("@napi-rs/canvas native binding smoke test", () => {
  it("creates a canvas, draws to it, and encodes a valid PNG", async () => {
    const canvas = createCanvas(64, 64);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#6366f1";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(16, 16, 32, 32);

    const png = await canvas.encode("png");

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);

    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
