import { z } from "zod";
import axios from "axios";
import type { AxiosError, AxiosInstance } from "axios";

declare module "axios" {
  export interface AxiosRequestConfig {
    skipErrorToast?: boolean;
  }
}

function errorMessageFromResponse(error: AxiosError): string {
  const data = error.response?.data;

  if (data && typeof data === "object") {
    const body = data as Record<string, unknown>;
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  }

  return "Something went wrong. Please try again.";
}

async function showApiErrorToast(error: AxiosError): Promise<void> {
  if (typeof window === "undefined") return;
  if (error.config?.skipErrorToast) return;

  const status = error.response?.status;
  if (!status || status < 400 || status > 599) return;

  const { toast } = await import("./toast");
  toast.error(errorMessageFromResponse(error));
}

let BASE_URL = process.env.NEXT_PUBLIC_API_URL;

if (!BASE_URL) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_API_URL is required in production");
  }
  BASE_URL = "http://localhost:3001/api";
}

try {
  const parsedUrl = new URL(BASE_URL);
  if (!parsedUrl.pathname.endsWith("/api")) {
    throw new Error("NEXT_PUBLIC_API_URL must end with /api");
  }
} catch (error) {
  if (error instanceof TypeError) {
    throw new Error("NEXT_PUBLIC_API_URL must be a valid URL");
  }
  throw error;
}

export function createApiClient(token?: string): AxiosInstance {
  const client = axios.create({
    baseURL: BASE_URL,
    withCredentials: true,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: 10_000,
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (axios.isAxiosError(error)) {
        await showApiErrorToast(error);

        if (
          token &&
          typeof window !== "undefined" &&
          error.response?.status === 401 &&
          !error.config?.url?.startsWith("/auth/")
        ) {
          // Show a session-expired notice before redirecting so users know why
          // they are being sent back to the login page (#357).
          // We import lazily to avoid pulling toast into every bundle that uses
          // the API client, and we set skipErrorToast so the generic error
          // handler above does not also fire for the same 401.
          try {
            const { toast } = await import("./toast");
            toast.error("Your session has expired. Please sign in again.");
          } catch {
            // toast may not be available in all environments — proceed silently
          }

          // Wait briefly so the toast is visible before the page navigates away.
          // 1 500 ms keeps us within the 2-second SLA stated in the acceptance
          // criteria while still giving users time to read the notice.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));

          const { signOut } = await import("next-auth/react");
          await signOut({ callbackUrl: "/login" });
        }
      }
      return Promise.reject(error);
    }
  );

  return client;
}

// Unauthenticated client for public endpoints
export const api = createApiClient();

// Types matching API responses
export interface Challenge {
  id: string;
  brand_id: string;
  challenge_id: string;
  pool_amount_stroops: string;
  pool_amount_usdc: string;
  status:
    | "pending_deposit"
    | "active"
    | "ended"
    | "settled"
    | "payout_failed"
    | "cancelled"
    | "refunded";
  starts_at: string;
  ends_at: string | null;
  // joined fields
  brand_name?: string;
  tagline?: string;
  logo_url?: string;
  primary_color?: string;
  secondary_color?: string;
}

export interface ChallengeQuestion {
  id: string;
  challenge_id: string;
  round: 1 | 2 | 3;
  question_type: string;
  prompt_type: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  // correct_option is NOT returned by the API
}

export interface LeaderboardEntry {
  rank: number;
  userId?: string;
  username: string;
  displayName?: string;
  league?: "bronze" | "silver" | "gold" | null;
  avatarUrl: string | null;
  totalScore: number;
  totalEarned?: string;
  endedAt: string | null;
}

const LeaderboardEntrySchema = z.object({
  rank: z.number(),
  userId: z.string().optional(),
  username: z.string(),
  displayName: z.string().optional(),
  league: z.enum(["bronze", "silver", "gold"]).nullable().optional(),
  avatarUrl: z.string().nullable(),
  totalScore: z.number(),
  totalEarned: z.string().optional(),
  endedAt: z.string().nullable(),
});

export function parseLeaderboardEntries(data: unknown): LeaderboardEntry[] {
  return z.array(LeaderboardEntrySchema).parse(data);
}

export interface UserProfile {
  userId?: string;
  displayName: string;
  username: string;
  league: "bronze" | "silver" | "gold" | null;
  totalEarned: string;
  totalChallenges: number;
  avatarUrl: string | null;
  streak?: number;
  bestScore?: number;
  createdAt?: string;
  isOwner?: boolean;
  recentSessions?: Array<{
    id: string;
    brandName: string;
    totalScore: number;
    rank?: number;
    completedAt: string;
  }>;
}

export interface StreakResponse {
  streak: number;
  lastPlayDay?: string | null;
  repairAvailable?: boolean;
  nextMilestone: number;
  progress: number;
  milestoneJustHit: boolean;
}

// ── Runtime validation schemas (catch API shape drift) ─────────────────────────

export const ChallengeSchema = z.object({
  id: z.string(),
  brand_id: z.string(),
  challenge_id: z.string(),
  pool_amount_stroops: z.string(),
  pool_amount_usdc: z.string(),
  status: z.enum(["pending_deposit", "active", "ended", "settled", "payout_failed"]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  brand_name: z.string().optional(),
  tagline: z.string().optional(),
  logo_url: z.string().optional(),
  primary_color: z.string().optional(),
  secondary_color: z.string().optional(),
});

export function parseChallenge(data: unknown): Challenge {
  return ChallengeSchema.parse(data);
}
