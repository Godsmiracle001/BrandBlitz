import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { api } from "@/lib/api";
import type { Metadata } from "next";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

interface PublicBrand {
  id: string;
  name: string;
  tagline: string | null;
  logo_url: string | null;
  primary_color: string | null;
  category: string | null;
  active_challenge_count: number;
}

export const metadata: Metadata = {
  title: "Brand Directory",
  description: "Browse all brands on BrandBlitz. Discover active challenges and compete for USDC rewards.",
  openGraph: {
    title: "Brand Directory — BrandBlitz",
    description: "Browse all brands on BrandBlitz. Discover active challenges and compete for USDC rewards.",
  },
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

async function getPublicBrands(): Promise<PublicBrand[]> {
  try {
    const res = await fetch(`${API_URL}/brands/public`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error("Failed to fetch");
    const data = await res.json();
    return data.brands ?? [];
  } catch {
    return [];
  }
}

function BrandDirectoryClient({ brands }: { brands: PublicBrand[] }) {
  const [query, setQuery] = React.useState("");
  const [activeLetter, setActiveLetter] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    let result = brands;
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter((b) => b.name.toLowerCase().includes(q));
    }
    if (activeLetter) {
      result = result.filter((b) => b.name.charAt(0).toUpperCase() === activeLetter);
    }
    return result;
  }, [brands, query, activeLetter]);

  const brandsByLetter = React.useMemo(() => {
    const map = new Map<string, PublicBrand[]>();
    for (const brand of filtered) {
      const letter = brand.name.charAt(0).toUpperCase();
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(brand);
    }
    return map;
  }, [filtered]);

  const usedLetters = React.useMemo(() => {
    const set = new Set(brands.map((b) => b.name.charAt(0).toUpperCase()));
    return set;
  }, [brands]);

  return (
    <div>
      <div className="mb-6">
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search brands..."
          aria-label="Search brands by name"
        />
      </div>

      <nav className="mb-6 flex flex-wrap gap-1" aria-label="Jump to letter">
        <button
          onClick={() => setActiveLetter(null)}
          className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${
            activeLetter === null
              ? "bg-[var(--primary)] text-white"
              : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
          }`}
        >
          All
        </button>
        {ALPHABET.map((letter) => {
          const isUsed = usedLetters.has(letter);
          const labelText = isUsed
            ? `Jump to brands starting with ${letter}`
            : `No brands starting with ${letter}`;
          return (
            <button
              key={letter}
              onClick={() => setActiveLetter(activeLetter === letter ? null : letter)}
              disabled={!isUsed}
              title={labelText}
              aria-label={labelText}
              className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${
                activeLetter === letter
                  ? "bg-[var(--primary)] text-white"
                  : isUsed
                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                    : "cursor-not-allowed text-[var(--muted-foreground)]/40"
              }`}
            >
              {letter}
            </button>
          );
        })}
      </nav>

      {filtered.length === 0 ? (
        <EmptyState
          title="No brands found"
          description={query ? "Try a different search term." : "No brands have been created yet."}
        />
      ) : (
        <div className="space-y-8">
          {Array.from(brandsByLetter.entries()).map(([letter, letterBrands]) => (
            <section key={letter} aria-label={`Brands starting with ${letter}`}>
              <h2 className="mb-3 text-lg font-bold text-[var(--muted-foreground)]">{letter}</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {letterBrands.map((brand) => (
                  <Link key={brand.id} href={`/brand/${brand.id}`}>
                    <Card className={`transition-shadow hover:shadow-md ${brand.active_challenge_count === 0 ? "opacity-60" : ""}`}>
                      <CardContent className="flex items-center gap-4 py-4">
                        {brand.logo_url ? (
                          <Image
                            src={brand.logo_url}
                            alt={brand.name}
                            width={48}
                            height={48}
                            sizes="48px"
                            className="h-12 w-12 rounded-lg object-contain"
                          />
                        ) : (
                          <div
                            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-lg font-bold text-white"
                            style={{ backgroundColor: brand.primary_color ?? "var(--primary)" }}
                          >
                            {brand.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-[var(--foreground)]">
                            {brand.name}
                          </p>
                          {brand.tagline && (
                            <p className="truncate text-xs text-[var(--muted-foreground)]">
                              {brand.tagline}
                            </p>
                          )}
                        </div>
                        <Badge
                          variant={brand.active_challenge_count > 0 ? "default" : "secondary"}
                          className="shrink-0"
                        >
                          {brand.active_challenge_count} active
                        </Badge>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default async function BrandsPage() {
  const brands = await getPublicBrands();

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold text-[var(--foreground)]">Brand Directory</h1>
        <p className="mt-2 text-[var(--muted-foreground)]">
          Browse all brands and discover active challenges.
        </p>
      </div>

      {brands.length === 0 ? (
        <EmptyState
          title="No brands yet"
          description="Brand owners will be listed here once they create their brand kits."
        />
      ) : (
        <BrandDirectoryClient brands={brands} />
      )}
    </main>
  );
}
