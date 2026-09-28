"use client";

/**
 * upload-field.tsx — Drag-and-drop / click file upload with full client-side
 * validation before any network call is made.
 *
 * Validation order (all happen before presign):
 *   1. MIME type check against the `uploadTypeConfig` allow-list
 *   2. File size check against the per-type limit
 *   3. Magic-byte check — reads the first 12 bytes to reject files whose
 *      binary signature does not match the declared MIME type (e.g. an .exe
 *      renamed to .png).
 *
 * Closes #160
 */

import { useRef, useState } from "react";
import Image from "next/image";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── Per-upload-type configuration ─────────────────────────────────────────────

export interface UploadTypeConfig {
  /** Allowed MIME types (exact match). */
  allowedMimes: string[];
  /** Maximum file size in bytes. */
  maxSizeBytes: number;
  /** Human-readable description shown in error messages. */
  label: string;
}

export const UPLOAD_TYPE_CONFIGS: Record<
  "brand-logo" | "product-image" | "user-avatar",
  UploadTypeConfig
> = {
  "brand-logo": {
    allowedMimes: ["image/png", "image/jpeg", "image/webp"],
    maxSizeBytes: 2 * 1024 * 1024, // 2 MB
    label: "Logo must be under 2 MB (PNG, JPG, or WebP)",
  },
  "product-image": {
    allowedMimes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    maxSizeBytes: 5 * 1024 * 1024, // 5 MB
    label: "Product image must be under 5 MB (PNG, JPG, WebP, or GIF)",
  },
  "user-avatar": {
    allowedMimes: ["image/png", "image/jpeg", "image/webp"],
    maxSizeBytes: 1 * 1024 * 1024, // 1 MB
    label: "Avatar must be under 1 MB (PNG, JPG, or WebP)",
  },
};

// ── Magic-byte signatures ─────────────────────────────────────────────────────

interface MagicSignature {
  /** Byte offset to start reading from. */
  offset: number;
  /** Expected bytes at that offset. */
  bytes: number[];
}

const MAGIC_BYTES: Record<string, MagicSignature[]> = {
  "image/png": [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  "image/webp": [
    // RIFF....WEBP
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  ],
  "image/gif": [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  ],
};

/**
 * Reads the first 12 bytes of `file` and checks them against known magic-byte
 * signatures for the declared MIME type.
 *
 * Returns `true` if the signature matches (or if the MIME type has no known
 * signature, e.g. SVG).  Returns `false` if the bytes clearly belong to a
 * different format.
 */
export async function validateMagicBytes(file: File): Promise<boolean> {
  const signatures = MAGIC_BYTES[file.type];
  // Unknown MIME — skip binary check, rely on MIME allow-list only.
  if (!signatures || signatures.length === 0) return true;

  const headerSize = 12;
  const slice = file.slice(0, headerSize);
  const buffer = await slice.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  return signatures.some((sig) => sig.bytes.every((b, i) => bytes[sig.offset + i] === b));
}

// ── MIME helper ───────────────────────────────────────────────────────────────

/** Returns true if mimeType is covered by the `accept` attribute value. */
function isAcceptedMime(mimeType: string, accept: string): boolean {
  return accept
    .split(",")
    .map((a) => a.trim())
    .some((a) => {
      if (a === "*" || a === "*/*") return true;
      if (a.endsWith("/*")) return mimeType.startsWith(a.slice(0, -1));
      return mimeType === a;
    });
}

// ── Retry helper ──────────────────────────────────────────────────────────────

/** Retry POST /upload/verify up to 3 times with 200 / 500 / 1000 ms backoff. */
async function verifyWithRetry(
  api: ReturnType<typeof createApiClient>,
  key: string
): Promise<void> {
  const delays = [200, 500, 1000];
  for (let i = 0; i < delays.length; i++) {
    try {
      await api.post("/upload/verify", { key });
      return;
    } catch (err) {
      if (i === delays.length - 1) throw err;
      await new Promise<void>((r) => setTimeout(r, delays[i]));
    }
  }
}

/** Upload with native byte progress when supported, falling back to fetch. */
export async function putWithProgress(
  uploadUrl: string,
  file: File,
  onProgress: (percent: number | null) => void
): Promise<void> {
  if (typeof XMLHttpRequest === "undefined") {
    onProgress(null);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    if (!response.ok) {
      throw new Error(response.status === 403 ? "upload-expired" : "upload-rejected");
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) {
        onProgress(null);
        return;
      }
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    request.onerror = () => reject(new Error("upload-rejected"));
    request.onabort = () => reject(new Error("upload-rejected"));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(request.status === 403 ? "upload-expired" : "upload-rejected"));
      }
    };
    request.send(file);
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

interface UploadFieldProps {
  label: string;
  /** Passed to the hidden <input accept="…"> for the OS file picker. */
  accept?: string;
  /**
   * Override the default per-type size limit.  Prefer leaving this unset and
   * letting `UPLOAD_TYPE_CONFIGS` drive the limit.
   */
  maxSizeBytes?: number;
  uploadType: "brand-logo" | "product-image" | "user-avatar";
  apiToken: string;
  onUploaded: (key: string, publicUrl: string) => void;
  className?: string;
}

export function UploadField({
  label,
  accept,
  maxSizeBytes,
  uploadType,
  apiToken,
  onUploaded,
  className,
}: UploadFieldProps) {
  const typeConfig = UPLOAD_TYPE_CONFIGS[uploadType];
  // Derive accept string from the type config if not explicitly provided.
  const resolvedAccept = accept ?? typeConfig.allowedMimes.join(",");
  const resolvedMaxBytes = maxSizeBytes ?? typeConfig.maxSizeBytes;

  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);

    // 1. MIME type check — no network calls on failure
    if (!isAcceptedMime(file.type, resolvedAccept)) {
      setError(typeConfig.label);
      setPendingFile(null);
      return;
    }

    // 2. File size check — no network calls on failure
    if (file.size > resolvedMaxBytes) {
      setError(typeConfig.label);
      setPendingFile(null);
      return;
    }

    // 3. Magic-byte check — rejects spoofed MIME (e.g. .exe renamed to .png)
    const magicOk = await validateMagicBytes(file);
    if (!magicOk) {
      setError(
        `The file does not appear to be a valid ${file.type.split("/")[1].toUpperCase()}. ` +
          `Please choose a genuine image file.`
      );
      setPendingFile(null);
      return;
    }

    setUploading(true);
    setUploadProgress(null);
    setPendingFile(file);

    let presignedKey: string | null = null;

    try {
      const api = createApiClient(apiToken);

      // 4. Get presigned URL
      const presignRes = await api.post("/upload/presign", {
        type: uploadType,
        contentType: file.type,
        contentLength: file.size,
      });

      const { uploadUrl, key, publicUrl } = presignRes.data;

      // 5. Upload directly to S3/MinIO
      await putWithProgress(uploadUrl, file, setUploadProgress);

      presignedKey = key;

      // 6. Verify upload — retries 3× (200 / 500 / 1000 ms backoff)
      try {
        await verifyWithRetry(api, key);
      } catch {
        // File made it to S3 but verify never confirmed — delete the orphan
        await api.delete("/upload/abort", { data: { key } }).catch(() => {});
        throw new Error("verify-failed");
      }

      presignedKey = null;
      setPendingFile(null);
      setUploadedUrl(publicUrl);
      onUploaded(key, publicUrl);
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : "";
      let message: string;
      switch (code) {
        case "verify-failed":
          message = "Upload could not be confirmed. The file has been removed. Please try again.";
          break;
        case "upload-expired":
          message = "Upload link expired before the file finished uploading. Please try again.";
          break;
        case "upload-rejected":
          message = "Storage rejected the upload. Please try again.";
          break;
        default:
          message = "Upload failed. Please try again.";
      }
      setError(message);
      void presignedKey;
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={resolvedAccept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {uploadedUrl ? (
        <div className="flex items-center gap-3">
          <Image
            src={uploadedUrl}
            alt={label}
            width={64}
            height={64}
            sizes="64px"
            className="h-16 w-16 rounded-lg border border-[var(--border)] object-contain"
          />
          <div>
            <p className="text-sm font-medium text-green-600">Uploaded</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setUploadedUrl(null);
                if (inputRef.current) inputRef.current.value = "";
              }}
            >
              Replace
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          aria-label={label}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
          }}
          onPaste={(e) => {
            const file = e.clipboardData.files[0];
            if (file) handleFile(file);
          }}
          disabled={uploading}
          className={cn(
            "w-full cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60",
            isDragging
              ? "bg-[var(--muted)]/50 border-[var(--primary)]"
              : "hover:bg-[var(--muted)]/50 border-[var(--border)] hover:border-[var(--primary)]"
          )}
        >
          {isDragging ? (
            <p className="text-sm font-medium text-[var(--primary)]">Drop here</p>
          ) : uploading ? (
            <div className="space-y-2" aria-live="polite">
              <p className="text-sm text-[var(--muted-foreground)]">
                {uploadProgress === null ? "Uploading..." : `Uploading ${uploadProgress}%`}
              </p>
              {uploadProgress !== null ? (
                <div
                  role="progressbar"
                  aria-label={`${label} upload progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadProgress}
                  className="mx-auto h-2 w-full max-w-xs overflow-hidden rounded-full bg-[var(--muted)]"
                >
                  <div
                    className="h-full bg-[var(--primary)] transition-[width]"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <p className="text-sm font-medium">{label}</p>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">{typeConfig.label}</p>
            </>
          )}
        </button>
      )}

      {error && (
        <div className="space-y-1">
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
          {pendingFile && (
            <Button variant="ghost" size="sm" onClick={() => handleFile(pendingFile)}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
