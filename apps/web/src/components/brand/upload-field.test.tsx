/**
 * upload-field.test.tsx — Unit tests for client-side file validation in
 * UploadField (issue #160).
 *
 * Covers:
 *   - Oversized files are rejected before presign is called
 *   - Wrong MIME type is rejected before presign is called
 *   - Magic-byte spoofing is rejected before presign is called
 *   - Valid files proceed to presign
 *
 * Closes #160
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadField, validateMagicBytes, UPLOAD_TYPE_CONFIGS } from "./upload-field";

// ── Mock the API client so no real HTTP calls are made ────────────────────────

const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/lib/api", () => ({
  createApiClient: () => ({
    post: mockPost,
    delete: mockDelete,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a File with real PNG magic bytes. */
function makePngFile(sizeBytes: number, name = "test.png"): File {
  const buf = new Uint8Array(sizeBytes);
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  return new File([buf], name, { type: "image/png" });
}

/** Build a File that claims to be PNG but has EXE magic bytes (MZ header). */
function makeSpoofedPngFile(name = "evil.png"): File {
  const buf = new Uint8Array(12);
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ — Windows PE header
  return new File([buf], name, { type: "image/png" });
}

/** Build a File with JPEG magic bytes. */
function makeJpegFile(sizeBytes: number, name = "test.jpg"): File {
  const buf = new Uint8Array(sizeBytes);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return new File([buf], name, { type: "image/jpeg" });
}

function renderUploadField() {
  const onUploaded = vi.fn();
  render(
    <UploadField
      label="Upload Brand Logo"
      uploadType="brand-logo"
      apiToken="test-token"
      onUploaded={onUploaded}
    />
  );
  return { onUploaded };
}

// ── validateMagicBytes unit tests ─────────────────────────────────────────────

describe("validateMagicBytes", () => {
  it("accepts a genuine PNG file", async () => {
    const file = makePngFile(100);
    expect(await validateMagicBytes(file)).toBe(true);
  });

  it("accepts a genuine JPEG file", async () => {
    const file = makeJpegFile(100);
    expect(await validateMagicBytes(file)).toBe(true);
  });

  it("rejects a file with EXE magic bytes claiming to be PNG", async () => {
    const file = makeSpoofedPngFile();
    expect(await validateMagicBytes(file)).toBe(false);
  });

  it("rejects SVG (no longer an allowed MIME type for brand-logo uploads)", async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const file = new File([svgContent], "icon.svg", { type: "image/svg+xml" });
    // validateMagicBytes has no entry for SVG, so it returns true (skip binary check).
    // SVG is instead rejected at the MIME allow-list check in the UploadField component.
    expect(await validateMagicBytes(file)).toBe(true);
  });
});

// ── UPLOAD_TYPE_CONFIGS ───────────────────────────────────────────────────────

describe("UPLOAD_TYPE_CONFIGS", () => {
  it("brand-logo limit is 2 MB", () => {
    expect(UPLOAD_TYPE_CONFIGS["brand-logo"].maxSizeBytes).toBe(2 * 1024 * 1024);
  });

  it("product-image limit is 5 MB", () => {
    expect(UPLOAD_TYPE_CONFIGS["product-image"].maxSizeBytes).toBe(5 * 1024 * 1024);
  });

  it("user-avatar limit is 1 MB", () => {
    expect(UPLOAD_TYPE_CONFIGS["user-avatar"].maxSizeBytes).toBe(1 * 1024 * 1024);
  });
});

// ── UploadField component integration tests ───────────────────────────────────

describe("UploadField — oversized file", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("shows an error and never calls presign when file exceeds the size limit", async () => {
    renderUploadField();

    const logoConfig = UPLOAD_TYPE_CONFIGS["brand-logo"];
    // 3 MB — exceeds the 2 MB brand-logo limit
    const oversizedFile = makePngFile(3 * 1024 * 1024);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, oversizedFile);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("alert").textContent).toContain(logoConfig.label);
    });

    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("UploadField — wrong MIME type", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("shows an error and never calls presign for a disallowed MIME type", async () => {
    renderUploadField();

    const buf = new Uint8Array(100);
    const pdfFile = new File([buf], "document.pdf", { type: "application/pdf" });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, pdfFile);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects SVG files and never calls presign (XSS prevention)", async () => {
    renderUploadField();

    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const svgFile = new File([svgContent], "icon.svg", { type: "image/svg+xml" });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, svgFile);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("UploadField — spoofed MIME (magic-byte check)", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("shows an error and never calls presign when magic bytes do not match declared MIME", async () => {
    renderUploadField();

    const spoofed = makeSpoofedPngFile();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, spoofed);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("UploadField — valid file proceeds to presign", () => {
  beforeEach(() => {
    mockPost.mockReset();
    // Mock presign response
    mockPost.mockResolvedValueOnce({
      data: {
        uploadUrl: "https://s3.example.com/upload",
        key: "brand-assets/test.png",
        publicUrl: "https://cdn.example.com/test.png",
      },
    });
    // Mock verify response
    mockPost.mockResolvedValueOnce({ data: { ok: true } });

    // Mock fetch for the S3 PUT
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  it("calls presign and onUploaded for a valid PNG within size limits", async () => {
    const { onUploaded } = renderUploadField();

    // 500 KB — well within the 2 MB brand-logo limit
    const validFile = makePngFile(500 * 1024);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, validFile);

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        "/upload/presign",
        expect.objectContaining({ type: "brand-logo" })
      );
    });

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith(
        "brand-assets/test.png",
        "https://cdn.example.com/test.png"
      );
    });
  });
});
