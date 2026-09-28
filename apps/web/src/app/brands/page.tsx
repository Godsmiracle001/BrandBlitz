"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

interface ActiveChallenge {
  id: string;
  brand_id: string;
  brand_name: string;
  logo_url: string | null;
}

interface DirectoryBrand {
  id: string;
  name: string;
  challengeIds: string[];
}

export default function BrandDirectoryPage() {
  const [brands, setBrands] = useState<DirectoryBrand[]>([]);
  const [query, setQuery] = useState("");
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadFailed(false);
      try {
        const client = createApiClient();
        const challenges: ActiveChallenge[] = [];
        let cursor: string | undefined;
        do {
          const params = new URLSearchParams({ limit: "100" });
          if (cursor) params.set("cursor", cursor);
          const response = await client.get(`/challenges?${params.toString()}`);
          challenges.push(...(response.data.data as ActiveChallenge[]));
          cursor = response.data.nextCursor ?? undefined;
        } while (cursor);

        const grouped = new Map<string, DirectoryBrand>();
        for (const challenge of challenges) {
          if (!challenge.brand_id || !challenge.brand_name) continue;
          const existing = grouped.get(challenge.brand_id);
          if (existing) existing.challengeIds.push(challenge.id);
          else {
            grouped.set(challenge.brand_id, {
              id: challenge.brand_id,
              name: challenge.brand_name,
              challengeIds: [challenge.id],
            });
          }
        }
        if (!cancelled)
          setBrands([...grouped.values()].sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return brands.filter((brand) => {
      const name = brand.name.toLocaleLowerCase();
      return (
        (!normalizedQuery || name.includes(normalizedQuery)) &&
        (!activeLetter || name.startsWith(activeLetter.toLocaleLowerCase()))
      );
    });
  }, [activeLetter, brands, query]);

  const noResultsDescription =
    query.trim() && activeLetter
      ? "No brands match both filters. Clear the search, the letter filter, or both."
      : query.trim()
        ? "Try a different search term."
        : activeLetter
          ? "Try another letter or clear the letter filter."
          : "No brands with active challenges are available right now.";

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold">Brand Directory</h1>
      <p className="mt-2 text-[var(--muted-foreground)]">Explore brands with active challenges.</p>

      <div className="my-6 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="brand-search">
          Search brands
        </label>
        <input
          id="brand-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search brands"
          className="bg-background min-h-10 min-w-56 rounded-md border px-3 text-sm"
        />
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Filter brands by first letter"
        >
          {"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => (
            <Button
              key={letter}
              size="sm"
              variant={activeLetter === letter ? "default" : "outline"}
              aria-pressed={activeLetter === letter}
              aria-label={`Brands starting with ${letter}`}
              onClick={() => setActiveLetter(activeLetter === letter ? null : letter)}
            >
              {letter}
            </Button>
          ))}
        </div>
        {(query || activeLetter) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQuery("");
              setActiveLetter(null);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {loading ? (
        <p role="status">Loading brands…</p>
      ) : loadFailed ? (
        <EmptyState title="Couldn't load brands" description="Refresh the page to try again." />
      ) : filtered.length === 0 ? (
        <EmptyState title="No brands found" description={noResultsDescription} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((brand) => (
            <Card key={brand.id}>
              <CardHeader>
                <CardTitle>{brand.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-[var(--muted-foreground)]">
                  {brand.challengeIds.length} active challenge
                  {brand.challengeIds.length === 1 ? "" : "s"}
                </p>
                <Link href={`/challenge/${brand.challengeIds[0]}`}>
                  <Button className="w-full">View active challenge</Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
