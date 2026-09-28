import { notFound } from "next/navigation";

/**
 * Debug page to test error boundaries.
 * Throws an error during render to trigger the nearest error.tsx.
 *
 * Not shipped as a live production route — only reachable in non-production
 * environments so it can't be hit accidentally in prod.
 */
export default function DebugErrorPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  throw new Error("Intentional debug crash");
}
