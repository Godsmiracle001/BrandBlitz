import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import type { Challenge } from "@/lib/api";

async function getActiveChallenges(): Promise<{ challenges: Challenge[]; failed: boolean }> {
  try {
    const res = await api.get("/challenges?limit=6");
    return {
      challenges: res.data.challenges,
      failed: false,
    };
  } catch {
    return {
      challenges: [],
      failed: true,
    };
  }
}

export default async function HomePage() {
  const { challenges, failed } = await getActiveChallenges();

  return (
    <main className="flex min-h-screen flex-col">
      {/* Hero */}
      <section className="flex flex-col items-center justify-center bg-gradient-to-b from-[var(--primary)] to-[var(--background)] px-6 py-24 text-center">
        <Badge variant="secondary" className="mb-4">
          Powered by Stellar USDC
        </Badge>
        <h1 className="mb-6 text-5xl font-extrabold leading-tight text-white md:text-7xl">
          Brand Challenges.
          <br />
          Real USDC Rewards.
        </h1>
        <p className="mb-10 max-w-xl text-lg text-white/80 md:text-xl">
          Study a brand for 30 seconds. Answer 3 questions. Top performers earn USDC instantly on
          Stellar.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Link href="/challenge">
            <Button size="lg" variant="secondary" className="px-8 text-lg">
              Play Now
            </Button>
          </Link>
          <Link href="/brands">
            <Button
              size="lg"
              variant="outline"
              className="border-white px-8 text-lg text-white hover:bg-white/10"
            >
              Browse Brands
            </Button>
          </Link>
          <Link href="/login">
            <Button
              size="lg"
              variant="outline"
              className="border-white px-8 text-lg text-white hover:bg-white/10"
            >
              Sign In
            </Button>
          </Link>
        </div>
      </section>

      {/* Active Challenges */}
      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <h2 className="mb-8 text-3xl font-bold">Active Challenges</h2>

        {failed ? (
          <p className="text-[var(--muted-foreground)]">
            Couldn&apos;t load active challenges right now. Refresh and try again.
          </p>
        ) : challenges.length === 0 ? (
          <p className="text-[var(--muted-foreground)]">
            No active challenges yet. Check back soon!
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {challenges.map((c) => (
              <Card key={c.id} className="transition-shadow hover:shadow-lg">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    {c.logo_url ? (
                      <Image
                        src={c.logo_url}
                        alt={c.brand_name ?? "Brand logo"}
                        width={160}
                        height={48}
                        sizes="160px"
                        className="h-12 w-auto object-contain"
                      />
                    ) : (
                      <div
                        className="h-12 w-12 rounded-lg"
                        style={{ backgroundColor: c.primary_color ?? "var(--primary)" }}
                      />
                    )}
                    <Badge variant="default">Active</Badge>
                  </div>
                  <CardTitle>{c.brand_name ?? "Untitled brand"}</CardTitle>
                  <CardDescription>
                    Prize pool: {formatUsdc(c.pool_amount_usdc)} USDC
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Link href={`/challenge/${c.id}`}>
                    <Button
                      className="w-full"
                      style={{ backgroundColor: c.primary_color ?? undefined }}
                    >
                      Accept Challenge
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* How It Works */}
      <section className="bg-[var(--muted)] px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold">How It Works</h2>
          <div className="grid grid-cols-1 gap-8 text-center md:grid-cols-3">
            {[
              {
                step: "1",
                title: "Study",
                desc: "30 seconds of brand content — logo, story, products.",
              },
              {
                step: "2",
                title: "Compete",
                desc: "3 rounds of questions based on what you just saw.",
              },
              {
                step: "3",
                title: "Earn",
                desc: "Top scorers earn USDC instantly to your Stellar wallet.",
              },
            ].map(({ step, title, desc }) => (
              <div key={step} className="space-y-3">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--primary)] text-xl font-bold text-white">
                  {step}
                </div>
                <h3 className="text-xl font-semibold">{title}</h3>
                <p className="text-[var(--muted-foreground)]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
