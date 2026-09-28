"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createApiClient } from "@/lib/api";
import { toast } from "@/lib/toast";

const REASON_OPTIONS = [
  { value: "misleading_content", label: "Misleading content" },
  { value: "inappropriate_language", label: "Inappropriate language" },
  { value: "factually_incorrect", label: "Factually incorrect" },
  { value: "other", label: "Other" },
] as const;

const MAX_NOTE_LENGTH = 500;
const RATE_LIMIT_MS = 60_000;

interface ReportModalProps {
  challengeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReportModal({ challengeId, open, onOpenChange }: ReportModalProps) {
  const [reason, setReason] = React.useState<string>("");
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const lastSubmitRef = React.useRef(0);

  const canSubmit = reason !== "" && !submitting;
  const isNearLimit = note.length >= MAX_NOTE_LENGTH * 0.85;
  const isAtLimit = note.length >= MAX_NOTE_LENGTH;

  React.useEffect(() => {
    if (!open) {
      setReason("");
      setNote("");
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const now = Date.now();
    if (now - lastSubmitRef.current < RATE_LIMIT_MS) {
      toast.warning("Please wait before submitting another report.");
      return;
    }

    setSubmitting(true);
    try {
      const api = createApiClient();
      await api.post(`/challenges/${challengeId}/report`, {
        reason,
        note: note.trim() || undefined,
      });
      lastSubmitRef.current = now;
      toast.success("Report submitted. Thank you for helping keep BrandBlitz safe.");
      onOpenChange(false);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        toast.error("You have already reported this challenge.");
        onOpenChange(false);
      } else {
        toast.error("Couldn't submit your report. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report Challenge</DialogTitle>
          <DialogDescription>
            Help us keep BrandBlitz safe. Select a reason for your report.
            {" "}
            <a href="/docs/guides/reporting-a-challenge" className="underline" target="_blank" rel="noopener noreferrer">
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset disabled={submitting}>
            <legend className="sr-only">Report reason</legend>
            <div className="space-y-2">
              {REASON_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-colors ${
                    reason === opt.value
                      ? "border-[var(--primary)] bg-[var(--primary)]/5"
                      : "border-[var(--border)] hover:bg-[var(--muted)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="reason"
                    value={opt.value}
                    checked={reason === opt.value}
                    onChange={(e) => setReason(e.target.value)}
                    className="sr-only"
                  />
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      reason === opt.value
                        ? "border-[var(--primary)] bg-[var(--primary)]"
                        : "border-[var(--muted-foreground)]"
                    }`}
                  >
                    {reason === opt.value && (
                      <span className="h-2 w-2 rounded-full bg-white" />
                    )}
                  </span>
                  {opt.label}
                </label>
              ))}
            </div>

            <div className="mt-4">
              <label htmlFor="report-note" className="mb-1 block text-sm font-medium text-[var(--foreground)]">
                Additional details (optional)
              </label>
              <textarea
                id="report-note"
                value={note}
                onChange={(e) => {
                  if (e.target.value.length <= MAX_NOTE_LENGTH) setNote(e.target.value);
                }}
                placeholder="Provide any extra context..."
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              />
              <p
                className={`mt-1 text-right text-xs transition-colors ${
                  isAtLimit
                    ? "font-semibold text-red-600"
                    : isNearLimit
                      ? "font-medium text-amber-600"
                      : "text-[var(--muted-foreground)]"
                }`}
              >
                {note.length}/{MAX_NOTE_LENGTH}
              </p>
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit}>
              {submitting ? "Submitting..." : "Submit Report"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
