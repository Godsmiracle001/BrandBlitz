import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function ChallengesLoading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="h-9 w-56 rounded bg-[var(--muted)] mb-2 animate-pulse" />
      <div className="h-5 w-80 rounded bg-[var(--muted)] mb-8 animate-pulse" />
      <div className="mb-6 flex flex-wrap gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 w-28 rounded bg-[var(--muted)] animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader>
              <div className="h-12 w-32 rounded bg-[var(--muted)] mb-2" />
              <div className="h-5 w-40 rounded bg-[var(--muted)]" />
            </CardHeader>
            <CardContent>
              <div className="h-4 w-24 rounded bg-[var(--muted)] mb-3" />
              <div className="h-10 w-full rounded bg-[var(--muted)]" />
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
