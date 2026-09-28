"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createApiClient } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Metadata } from "next";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateShareText(position?: number): string {
  const base = "BrandBlitz is launching soon — earn USDC by mastering brand challenges!";
  if (position) {
    return `${base} I'm #${position} on the waitlist! Join me:`;
  }
  return `${base} Join the waitlist:`;
}

const JOINED_STORAGE_KEY = "brandblitz:waitlist:joined";

interface JoinedWaitlist {
  email: string;
  position: number | null;
  ref: string;
}

function readJoinedWaitlist(): JoinedWaitlist | null {
  try {
    const raw = window.localStorage.getItem(JOINED_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<JoinedWaitlist>;
    if (typeof parsed.email !== "string" || parsed.email.length === 0) return null;
    return {
      email: parsed.email,
      position: typeof parsed.position === "number" ? parsed.position : null,
      ref: typeof parsed.ref === "string" ? parsed.ref : "",
    };
  } catch {
    return null;
  }
}

function persistJoinedWaitlist(joined: JoinedWaitlist): void {
  try {
    window.localStorage.setItem(JOINED_STORAGE_KEY, JSON.stringify(joined));
  } catch {
    // localStorage can be unavailable (private mode / quota). The success view
    // still works for this session; it just won't survive a refresh.
  }
}

async function fetchWaitlistPosition(
  api: ReturnType<typeof createApiClient>,
  email: string
): Promise<number | null> {
  try {
    const res = await api.get(`/waitlist/position/${encodeURIComponent(email)}`, {
      skipErrorToast: true,
    });
    return typeof res.data.position === "number" ? res.data.position : null;
  } catch {
    return null;
  }
}

export default function WaitlistPage() {
  const [email, setEmail] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "submitting" | "success">("idle");
  const [position, setPosition] = React.useState<number | null>(null);
  const [ref, setRef] = React.useState<string>("");

  React.useEffect(() => {
    const joined = readJoinedWaitlist();
    if (!joined) return;
    setEmail(joined.email);
    setPosition(joined.position);
    setRef(joined.ref);
    setStatus("success");
  }, []);

  const shareText = generateShareText(position ?? undefined);
  const shareUrl = typeof window !== "undefined" ? window.location.origin : "";
  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl + (ref ? `?ref=${ref}` : ""))}`;
  const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl + (ref ? `?ref=${ref}` : ""))}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidEmail(email)) {
      toast.error("Please enter a valid email address.");
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = readJoinedWaitlist();
    if (existing && existing.email.toLowerCase() === normalizedEmail) {
      setPosition(existing.position);
      setRef(existing.ref);
      setStatus("success");
      toast.info("You are already on the waitlist!");
      return;
    }

    setStatus("submitting");
    try {
      const api = createApiClient();
      const res = await api.post("/waitlist", { email });
      const joinedPosition =
        typeof res.data.position === "number"
          ? res.data.position
          : await fetchWaitlistPosition(api, normalizedEmail);
      const joinedRef = typeof res.data.ref === "string" ? res.data.ref : "";
      setPosition(joinedPosition);
      setRef(joinedRef);
      setStatus("success");
      persistJoinedWaitlist({ email: normalizedEmail, position: joinedPosition, ref: joinedRef });
      if (res.data.message === "You are already on the waitlist.") {
        toast.info("You are already on the waitlist!");
      } else {
        toast.success("Welcome to the waitlist!");
      }
    } catch {
      toast.error("Couldn't join the waitlist. Please try again.");
      setStatus("idle");
    }
  }

  function copyLink() {
    const url = shareUrl + (ref ? `?ref=${ref}` : "");
    navigator.clipboard.writeText(url).then(
      () => toast.success("Link copied to clipboard!"),
      () => toast.error("Couldn't copy link.")
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-lg">
        <div className="mb-10 text-center">
          <h1 className="mb-4 text-4xl font-extrabold leading-tight text-[var(--foreground)] md:text-5xl">
            Coming Soon
          </h1>
          <p className="text-lg text-[var(--muted-foreground)]">
            Earn USDC by mastering brand challenges.
            <br />
            Be the first to play when we launch.
          </p>
        </div>

        {status === "success" ? (
          <Card>
            <CardContent className="py-10 text-center">
              <p className="mb-2 text-lg font-semibold text-[var(--foreground)]">
                You&apos;re on the list!
              </p>
              {position !== null && (
                <p className="mb-6 text-3xl font-bold text-[var(--primary)]">
                  #{position}
                </p>
              )}
              <p className="mb-6 text-sm text-[var(--muted-foreground)]">
                Share with friends to move up the waitlist.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Button asChild variant="outline" size="sm">
                  <a href={twitterUrl} target="_blank" rel="noopener noreferrer">
                    Share on X
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href={linkedinUrl} target="_blank" rel="noopener noreferrer">
                    Share on LinkedIn
                  </a>
                </Button>
                <Button variant="outline" size="sm" onClick={copyLink}>
                  Copy Link
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-8">
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="waitlist-email" className="mb-1 block text-sm font-medium text-[var(--foreground)]">
                    Email address
                  </label>
                  <Input
                    id="waitlist-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    aria-describedby="email-hint"
                    disabled={status === "submitting"}
                  />
                  <p id="email-hint" className="mt-1 text-xs text-[var(--muted-foreground)]">
                    We&apos;ll only use this to notify you when we launch.
                  </p>
                </div>
                <Button type="submit" className="w-full" disabled={status === "submitting"}>
                  {status === "submitting" ? "Joining..." : "Join Waitlist"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <div className="mt-12 grid grid-cols-3 gap-6 text-center">
          {[
            { step: "1", title: "Join", desc: "Sign up for early access" },
            { step: "2", title: "Play", desc: "Study brands, answer fast" },
            { step: "3", title: "Earn", desc: "Win USDC on Stellar" },
          ].map(({ step, title, desc }) => (
            <div key={step} className="space-y-2">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-bold text-white">
                {step}
              </div>
              <p className="text-sm font-semibold text-[var(--foreground)]">{title}</p>
              <p className="text-xs text-[var(--muted-foreground)]">{desc}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-sm text-[var(--muted-foreground)]">
          <Link href="/" className="underline hover:text-[var(--foreground)]">
            Back to BrandBlitz
          </Link>
        </p>
      </div>
    </main>
  );
}
