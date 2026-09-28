"use client";

import { z } from "zod";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { UploadField } from "./upload-field";
import { useSubmitting } from "@/hooks/use-submitting";

interface BrandKitFormProps {
  apiToken: string;
}

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const MIN_CHALLENGE_DURATION_HOURS = 1;
const MAX_CHALLENGE_DURATION_HOURS = 720;

const FormSchema = z.object({
  name: z.string().trim().min(1, "Brand name is required").max(100),
  tagline: z.string().max(100, "Tagline must be 100 characters or fewer").optional(),
  brandStory: z.string().max(500, "Brand story must be 500 characters or fewer").optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid primary color"),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid secondary color"),
  poolAmountUsdc: z
    .string()
    .min(1, "Prize pool is required")
    .refine((val) => Number(val) >= 10, "Minimum pool amount is 10 USDC"),
  durationHours: z.string().refine((val) => {
    const num = Number(val);
    return (
      Number.isInteger(num) &&
      num >= MIN_CHALLENGE_DURATION_HOURS &&
      num <= MAX_CHALLENGE_DURATION_HOURS
    );
  }, "Duration must be between 1 and 720 hours"),
});

type BrandKitFields = z.infer<typeof FormSchema>;
type FieldName = keyof BrandKitFields;

export function BrandKitForm({ apiToken }: BrandKitFormProps) {
  const router = useRouter();
  const { submitting, wrap, setSubmitting } = useSubmitting();
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});

  const [fields, setFields] = useState({
    name: "",
    tagline: "",
    brandStory: "",
    primaryColor: "#6366f1",
    secondaryColor: "#a5b4fc",
    poolAmountUsdc: "",
    durationHours: "72",
  });

  const [logoKey, setLogoKey] = useState<string | null>(null);
  const [productImageKeys, setProductImageKeys] = useState<string[]>([]);

  const hasRequiredFields = fields.name.trim() !== "" && fields.poolAmountUsdc.trim() !== "";
  const hasValidColors =
    HEX_COLOR_PATTERN.test(fields.primaryColor) && HEX_COLOR_PATTERN.test(fields.secondaryColor);
  const hasValidPoolAmount =
    fields.poolAmountUsdc.trim() !== "" && Number(fields.poolAmountUsdc) >= 10;
  const hasValidDuration =
    fields.durationHours.trim() !== "" &&
    Number.isInteger(Number(fields.durationHours)) &&
    Number(fields.durationHours) >= MIN_CHALLENGE_DURATION_HOURS &&
    Number(fields.durationHours) <= MAX_CHALLENGE_DURATION_HOURS;
  const canSubmit =
    !submitting &&
    hasRequiredFields &&
    hasValidColors &&
    hasValidPoolAmount &&
    hasValidDuration &&
    Boolean(logoKey);
  const liveValidation = FormSchema.safeParse(fields);
  const fieldErrors: Partial<Record<FieldName, string>> = {};
  if (!liveValidation.success) {
    for (const issue of liveValidation.error.issues) {
      const field = issue.path[0] as FieldName | undefined;
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
  }
  const unmetRequirements = [
    !hasRequiredFields && "Enter a brand name and prize pool amount.",
    !hasValidColors && "Use valid six-digit hex colors.",
    !hasValidPoolAmount && "Set a prize pool of at least 10 USDC.",
    !hasValidDuration && "Set a duration between 1 and 720 whole hours.",
    !logoKey && "Upload a brand logo (required).",
  ].filter((requirement): requirement is string => Boolean(requirement));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }

    setError(null);

    const validationResult = FormSchema.safeParse(fields);
    if (!validationResult.success) {
      setTouched({
        name: true,
        tagline: true,
        brandStory: true,
        primaryColor: true,
        secondaryColor: true,
        poolAmountUsdc: true,
        durationHours: true,
      });
      setError("Review the highlighted fields and try again.");
      return;
    }

    try {
      await wrap(async () => {
        const api = createApiClient(apiToken);
        const [productImage1Key, productImage2Key] = productImageKeys;

        // Note: The API expects S3 keys (logoKey, productImageKeys).
        // The backend handles the conversion from these keys to public URLs after optimizing.
        const brandRes = await api.post(
          "/brands",
          {
            name: fields.name,
            tagline: fields.tagline,
            brandStory: fields.brandStory,
            primaryColor: fields.primaryColor,
            secondaryColor: fields.secondaryColor,
            logoKey,
            usp: fields.tagline || undefined,
            productImage1Key: productImageKeys[0],
            productImage2Key: productImageKeys[1],
          },
          { skipErrorToast: true }
        );

        const brandId = brandRes.data.brand.id;
        const parsedDurationHours = Number.parseInt(fields.durationHours, 10);
        const durationHours =
          Number.isFinite(parsedDurationHours) && parsedDurationHours > 0
            ? parsedDurationHours
            : 72;
        const nowMs = Date.now();
        const endsAtMs = nowMs + durationHours * 60 * 60 * 1000;
        if (endsAtMs < nowMs + MIN_CHALLENGE_DURATION_HOURS * 60 * 60 * 1000) {
          setError("Challenge duration must be at least 1 hour.");
          return;
        }
        const endsAt = new Date(endsAtMs).toISOString();

        // Fix path if it should be /challenges instead of /brands/challenges or vice-versa
        // Assuming backend uses /brands/challenges based on the routes
        const challengeRes = await api.post(
          "/brands/challenges",
          {
            brandId,
            poolAmountUsdc: fields.poolAmountUsdc,
            endsAt,
          },
          { skipErrorToast: true }
        );

        // Deposit info is now fetched server-side from /challenges/:id/deposit-info
        // Do NOT include secrets in URL query params
        router.push(`/brand/${brandId}`);
      });
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Failed to create brand. Please try again.");
    }
  };

  const set = (k: FieldName) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFields((prev) => ({ ...prev, [k]: e.target.value }));
    setTouched((prev) => ({ ...prev, [k]: true }));
  };

  const fieldError = (field: FieldName) =>
    touched[field] && fieldErrors[field] ? (
      <p id={`${field}Error`} role="alert" className="text-xs text-red-500">
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Brand Info */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="text-lg font-semibold">Brand Information</h2>

          <div className="space-y-2">
            <Label htmlFor="name">Brand Name *</Label>
            <Input
              id="name"
              value={fields.name}
              onChange={set("name")}
              placeholder="e.g. Acme Corp"
              required
              aria-invalid={Boolean(touched.name && fieldErrors.name)}
              aria-describedby={touched.name && fieldErrors.name ? "nameError" : undefined}
            />
            {fieldError("name")}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tagline">Tagline</Label>
            <Input
              id="tagline"
              value={fields.tagline}
              onChange={set("tagline")}
              placeholder="Your brand's catchy one-liner"
              maxLength={120}
            />
            {fieldError("tagline")}
          </div>

          <div className="space-y-2">
            <Label htmlFor="brandStory">Brand Story</Label>
            <textarea
              id="brandStory"
              value={fields.brandStory}
              onChange={set("brandStory")}
              placeholder="What makes your brand unique? (used to generate quiz questions)"
              rows={4}
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
            {fieldError("brandStory")}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="primaryColor">Primary Color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  id="primaryColor"
                  value={fields.primaryColor}
                  onChange={set("primaryColor")}
                  className="h-10 w-14 cursor-pointer rounded border border-[var(--border)]"
                />
                <Input
                  id="primaryColorHex"
                  aria-label="Primary Color Hex"
                  value={fields.primaryColor}
                  onChange={set("primaryColor")}
                  placeholder="#6366f1"
                  className="font-mono"
                  pattern="^#[0-9a-f]{6}$"
                  aria-invalid={!HEX_COLOR_PATTERN.test(fields.primaryColor)}
                  aria-describedby={
                    !HEX_COLOR_PATTERN.test(fields.primaryColor)
                      ? "primaryColorHexError"
                      : undefined
                  }
                  spellCheck={false}
                />
              </div>
              {!HEX_COLOR_PATTERN.test(fields.primaryColor) ? (
                <p id="primaryColorHexError" className="text-xs text-red-500">
                  Use format `#rrggbb` in lowercase.
                </p>
              ) : null}
              {fieldError("primaryColor")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="secondaryColor">Secondary Color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  id="secondaryColor"
                  value={fields.secondaryColor}
                  onChange={set("secondaryColor")}
                  className="h-10 w-14 cursor-pointer rounded border border-[var(--border)]"
                />
                <Input
                  id="secondaryColorHex"
                  aria-label="Secondary Color Hex"
                  value={fields.secondaryColor}
                  onChange={set("secondaryColor")}
                  placeholder="#a5b4fc"
                  className="font-mono"
                  pattern="^#[0-9a-f]{6}$"
                  aria-invalid={!HEX_COLOR_PATTERN.test(fields.secondaryColor)}
                  aria-describedby={
                    !HEX_COLOR_PATTERN.test(fields.secondaryColor)
                      ? "secondaryColorHexError"
                      : undefined
                  }
                  spellCheck={false}
                />
              </div>
              {!HEX_COLOR_PATTERN.test(fields.secondaryColor) ? (
                <p id="secondaryColorHexError" className="text-xs text-red-500">
                  Use format `#rrggbb` in lowercase.
                </p>
              ) : null}
              {fieldError("secondaryColor")}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Brand Assets */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="text-lg font-semibold">Brand Assets</h2>

          <div className="space-y-2">
            <Label>Logo *</Label>
            <UploadField
              label="Upload Brand Logo"
              uploadType="brand-logo"
              apiToken={apiToken}
              onUploaded={(key) => setLogoKey(key)}
            />
          </div>

          <div className="space-y-2">
            <Label>Product Images (optional)</Label>
            <UploadField
              label="Upload Product Image"
              uploadType="product-image"
              apiToken={apiToken}
              onUploaded={(key) =>
                setProductImageKeys((prev) => {
                  if (prev.length >= 2) return prev;
                  return [...prev, key];
                })
              }
            />
            {productImageKeys.length > 0 && (
              <p className="text-xs text-green-600">
                {productImageKeys.length}/2 image(s) uploaded
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Challenge Settings */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="text-lg font-semibold">Challenge Settings</h2>

          <div className="space-y-2">
            <Label htmlFor="poolAmountUsdc">Prize Pool (USDC) *</Label>
            <Input
              id="poolAmountUsdc"
              type="number"
              step="0.01"
              min="10"
              value={fields.poolAmountUsdc}
              onChange={set("poolAmountUsdc")}
              placeholder="e.g. 100.00"
              required
              aria-invalid={Boolean(touched.poolAmountUsdc && fieldErrors.poolAmountUsdc)}
              aria-describedby={
                touched.poolAmountUsdc && fieldErrors.poolAmountUsdc
                  ? "poolAmountUsdcError"
                  : undefined
              }
            />
            {fieldError("poolAmountUsdc")}
            <p className="text-xs text-[var(--muted-foreground)]">
              You will receive a Stellar deposit address to fund the prize pool after creation.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="durationHours">Challenge Duration (hours)</Label>
            <Input
              id="durationHours"
              type="number"
              min={MIN_CHALLENGE_DURATION_HOURS}
              max={MAX_CHALLENGE_DURATION_HOURS}
              value={fields.durationHours}
              onChange={set("durationHours")}
              aria-invalid={Boolean(touched.durationHours && fieldErrors.durationHours)}
              aria-describedby={
                touched.durationHours && fieldErrors.durationHours
                  ? "durationHoursError"
                  : undefined
              }
            />
            {fieldError("durationHours")}
          </div>
        </CardContent>
      </Card>

      {error && (
        <p
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-500"
        >
          {error}
        </p>
      )}

      {!submitting && unmetRequirements.length > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <p className="font-medium">Complete these requirements to create your brand kit:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {unmetRequirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Button type="submit" size="lg" className="w-full" disabled={!canSubmit}>
        {submitting ? "Creating..." : "Create Brand Kit & Challenge"}
      </Button>
    </form>
  );
}
