"use client";

import { useState } from "react";

interface ActivityRecord {
  date: string;
  session_count: number;
}

interface StreakHeatmapProps {
  activity: ActivityRecord[];
}

export function StreakHeatmap({ activity }: StreakHeatmapProps) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  if (!activity || activity.length === 0) {
    return null;
  }

  const getIntensityLevel = (count: number): number => {
    if (count === 0) return 0;
    if (count === 1) return 1;
    if (count <= 3) return 2;
    if (count <= 6) return 3;
    return 4;
  };

  const getColorClass = (count: number): string => {
    const level = getIntensityLevel(count);
    const colors = [
      "bg-slate-100",
      "bg-indigo-200",
      "bg-indigo-400",
      "bg-indigo-600",
      "bg-indigo-800",
    ];
    return colors[level];
  };

  const getDarkColorClass = (count: number): string => {
    const level = getIntensityLevel(count);
    const colors = [
      "dark:bg-slate-900",
      "dark:bg-indigo-900",
      "dark:bg-indigo-700",
      "dark:bg-indigo-500",
      "dark:bg-indigo-300",
    ];
    return colors[level];
  };

  const getCellGroupsByWeek = (): ActivityRecord[][] => {
    if (activity.length === 0) return [];

    const startDate = new Date(activity[0].date);
    const dayOfWeek = startDate.getDay();
    const weeksWithPadding = [];

    for (let i = 0; i < dayOfWeek; i++) {
      weeksWithPadding.push({ date: "", session_count: 0 });
    }

    weeksWithPadding.push(...activity);

    const weeks: ActivityRecord[][] = [];
    for (let i = 0; i < weeksWithPadding.length; i += 7) {
      weeks.push(weeksWithPadding.slice(i, i + 7));
    }

    const lastWeek = weeks[weeks.length - 1];
    while (lastWeek.length < 7) {
      lastWeek.push({ date: "", session_count: 0 });
    }

    return weeks;
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr + "T00:00:00Z");
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const weeks = getCellGroupsByWeek();

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);
  const displayWeeks = isMobile ? weeks.slice(-26) : weeks;

  const handleCellHover = (
    e: React.MouseEvent<HTMLDivElement>,
    date: string
  ) => {
    if (!date) return;
    const rect = e.currentTarget.getBoundingClientRect();
    let tooltipX = rect.left + rect.width / 2; // Center tooltip initially
    const tooltipWidth = 150; // Estimated tooltip width
    const padding = 10; // Padding from screen edge

    if (tooltipX + tooltipWidth / 2 + padding > window.innerWidth) {
      tooltipX = window.innerWidth - tooltipWidth / 2 - padding;
    } else if (tooltipX - tooltipWidth / 2 - padding < 0) {
      tooltipX = tooltipWidth / 2 + padding;
    }
    setTooltipPos({ x: tooltipX, y: rect.top });
    setHoveredDate(date);
  };

  const hoveredRecord = activity.find((r) => r.date === hoveredDate);

  return (
    <div className="w-full">
      <div className="inline-block">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${displayWeeks.length}, 1fr)` }}>
          {displayWeeks.map((week, weekIndex) =>
            week.map((record, dayIndex) => (
              <div
                key={`${weekIndex}-${dayIndex}`}
                onMouseEnter={(e) => handleCellHover(e, record.date)}
                onMouseLeave={() => setHoveredDate(null)}
                className={`h-3 w-3 rounded-sm border border-[var(--border)] transition-all ${
                  record.date
                    ? `${getColorClass(record.session_count)} ${getDarkColorClass(record.session_count)} cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-[var(--primary)]`
                    : "bg-slate-50 dark:bg-slate-800"
                } ${hoveredDate === record.date ? "ring-2 ring-offset-1 ring-[var(--primary)]" : ""}`}
              />
            ))
          )}
        </div>

        {hoveredRecord && hoveredDate && (
          <div
            className="absolute z-50 rounded-md bg-slate-900 px-2 py-1 text-xs text-white"
            style={{
              left: `${tooltipPos.x}px`,
              top: `${tooltipPos.y - 40}px`,
              pointerEvents: "none",
            }}
          >
            {hoveredRecord.session_count} {hoveredRecord.session_count === 1 ? "session" : "sessions"} on{" "}
            {formatDate(hoveredDate)}
          </div>
        )}
      </div>
    </div>
  );
}
