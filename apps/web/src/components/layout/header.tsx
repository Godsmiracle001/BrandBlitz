"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSession, signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "./notification-bell";

export function Header() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [streak, setStreak] = useState<number | null>(null);

  const apiToken = useMemo(() => (session as any)?.apiToken as string | undefined, [session]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[aria-label='Open menu']")) return;
      if (target.closest("#mobile-menu-panel")) return;
      setMenuOpen(false);
    }

    document.addEventListener("click", handleClickOutside, true);
    return () => document.removeEventListener("click", handleClickOutside, true);
  }, [menuOpen]);

  useEffect(() => {
    if (!apiToken) {
      return;
    }

    const api = createApiClient(apiToken);
    void api.get("/users/me/streak").then((response) => {
      const data = response.data;
      setStreak(data.streak ?? null);
    });
  }, [apiToken]);

  const navLinks = (
    <>
      <Link
        href="/challenge"
        className="block py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        onClick={() => setMenuOpen(false)}
      >
        Challenges
      </Link>
      <Link
        href="/leaderboard"
        className="block py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        onClick={() => setMenuOpen(false)}
      >
        Leaderboard
      </Link>
      {session && (
        <Link
          href="/dashboard"
          className="block py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          onClick={() => setMenuOpen(false)}
        >
          Dashboard
        </Link>
      )}
    </>
  );

  return (
    <header className="border-b border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="font-extrabold text-xl text-[var(--primary)]">
          BrandBlitz
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-6 text-sm">{navLinks}</nav>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          {apiToken && <NotificationBell apiToken={apiToken} />}

          {/* Hamburger — mobile only */}
          <button
            className="md:hidden flex flex-col justify-center items-center w-10 h-10 gap-1.5 rounded-md hover:bg-[var(--muted)] transition-colors"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <span className="block h-0.5 w-5 bg-[var(--foreground)] transition-transform" />
            <span className="block h-0.5 w-5 bg-[var(--foreground)]" />
            <span className="block h-0.5 w-5 bg-[var(--foreground)] transition-transform" />
          </button>

          {status === "loading" ? null : session ? (
            <div className="hidden md:flex items-center gap-3">
              {session.user?.image ? (
                <Image
                  src={session.user.image}
                  alt={session.user.name ?? "User"}
                  width={32}
                  height={32}
                  sizes="32px"
                  className="h-8 w-8 rounded-full object-cover"
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-[var(--primary)] flex items-center justify-center text-white text-sm font-bold">
                  {session.user?.name?.charAt(0).toUpperCase() ?? "U"}
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={() => signOut()}>
                Sign Out
              </Button>
            </div>
          ) : (
            <Link href="/login" className="hidden md:block">
              <Button size="sm">Sign In</Button>
            </Link>
          )}
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div id="mobile-menu-panel" className="md:hidden border-t border-[var(--border)] bg-[var(--background)] px-6 pb-4">
          <nav className="flex flex-col text-sm pt-3">{navLinks}</nav>
          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            {session ? (
              <div className="flex items-center gap-3">
                {session.user?.image ? (
                  <Image
                    src={session.user.image}
                    alt={session.user.name ?? "User"}
                    width={32}
                    height={32}
                    sizes="32px"
                    className="h-8 w-8 rounded-full object-cover"
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-[var(--primary)] flex items-center justify-center text-white text-sm font-bold">
                    {session.user?.name?.charAt(0).toUpperCase() ?? "U"}
                  </div>
                )}
                <span className="text-sm text-[var(--foreground)]">{session.user?.name}</span>
                <Button variant="ghost" size="sm" onClick={() => signOut()} className="ml-auto">
                  Sign Out
                </Button>
              </div>
            ) : (
              <Link href="/login" onClick={() => setMenuOpen(false)}>
                <Button size="sm" className="w-full min-h-[44px]">
                  Sign In
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
