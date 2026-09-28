"use client";

import { useEffect, useState } from "react";
import { createApiClient } from "@/lib/api";

interface PublicConfig {
  game_round_duration_seconds?: number;
  max_rounds_per_session?: number;
  maintenance_mode?: boolean;
  [key: string]: unknown;
}

export function usePublicConfig(): { config: PublicConfig | null } {
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    createApiClient()
      .get<PublicConfig>("/config", { skipErrorToast: true })
      .then((res) => {
        if (!cancelled) setConfig(res.data);
      })
      .catch(() => {
        // Config is best-effort; the app should keep working with defaults.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config };
}
