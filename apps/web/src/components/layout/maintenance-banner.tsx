"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePublicConfig } from "@/hooks/use-public-config";

interface MaintenanceBannerProps {
  className?: string;
}

export function MaintenanceBanner({ className }: MaintenanceBannerProps) {
  const { config } = usePublicConfig();

  if (!config?.maintenance_mode) return null;

  const eta = (config?.maintenance_eta ?? config?.eta) as string | undefined;
  const statusPageUrl = (config?.status_page_url ?? config?.status_url ?? config?.maintenance_status_page_url ?? config?.status_page) as string | undefined;
  const isExternal = statusPageUrl ? /^https?:\/\//i.test(statusPageUrl) : false;

  return (
    <div
      className={cn(
        "sticky top-0 z-50 w-full border-b border-amber-700 bg-amber-300 px-4 py-3 text-amber-950 shadow-sm",
        className,
      )}
      role="status"
      aria-live="assertive"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-center gap-2 text-sm font-semibold flex-wrap">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          BrandBlitz is undergoing maintenance.{eta ? ` Expected resolution: ${eta}.` : ""} Some features may be unavailable.
        </span>
        {statusPageUrl && (
          <a
            href={statusPageUrl}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noopener noreferrer" : undefined}
            className="underline hover:opacity-80 transition-opacity ml-1"
          >
            Check status page
          </a>
        )}
      </div>
    </div>
  );
}
