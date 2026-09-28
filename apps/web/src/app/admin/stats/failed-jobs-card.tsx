import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface FailedJob {
  id: string;
  queue: string;
  name: string;
  attemptsMade: number;
  failedReason: string | null;
  failedAt: string | null;
  retryable: boolean;
}

interface FailedJobsCardProps {
  jobs: FailedJob[];
  retryingJobId: string | null;
  onRetry: (job: FailedJob) => void;
}

function formatFailedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function FailedJobsCard({ jobs, retryingJobId, onRetry }: FailedJobsCardProps) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Failed Jobs</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">No failed jobs</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-xs font-medium text-gray-500">
                  <th className="px-4 py-3">Job ID</th>
                  <th className="px-4 py-3">Queue</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Attempts</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Failed At</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={`${job.queue}:${job.id}`}
                    className="border-b last:border-0 hover:bg-gray-50"
                  >
                    <td
                      className="max-w-[180px] truncate px-4 py-3 font-mono text-xs"
                      title={job.id}
                    >
                      {job.id}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{job.queue}</Badge>
                    </td>
                    <td className="px-4 py-3">{job.name}</td>
                    <td className="px-4 py-3 text-right font-mono">{job.attemptsMade}</td>
                    <td
                      className="max-w-[240px] truncate px-4 py-3 text-red-600"
                      title={job.failedReason ?? undefined}
                    >
                      {job.failedReason ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted-foreground)]">
                      {formatFailedAt(job.failedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!job.retryable || retryingJobId === job.id}
                        title={
                          job.retryable
                            ? "Requeue this failed job"
                            : "This queue is not eligible for manual retry"
                        }
                        onClick={() => onRetry(job)}
                      >
                        {retryingJobId === job.id ? "Retrying…" : "Retry"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
