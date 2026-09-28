import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  lag: number;
}

export type QueueStats = Record<string, QueueMetrics | { error: "unavailable" }>;

export function QueueStatsCard({ queues }: { queues: QueueStats }) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Queue Health</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs font-medium text-gray-500">
                <th className="px-4 py-3">Queue</th>
                <th className="px-4 py-3 text-right">Waiting</th>
                <th className="px-4 py-3 text-right">Active</th>
                <th className="px-4 py-3 text-right">Completed</th>
                <th className="px-4 py-3 text-right">Failed</th>
                <th className="px-4 py-3 text-right">Delayed</th>
                <th className="px-4 py-3 text-right">Lag (ms)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(queues).map(([name, stats]) => (
                <tr key={name} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{name}</td>
                  {"error" in stats ? (
                    <td className="px-4 py-3 text-red-600" colSpan={6}>
                      Unavailable
                    </td>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-right font-mono">{stats.waiting}</td>
                      <td className="px-4 py-3 text-right font-mono">{stats.active}</td>
                      <td className="px-4 py-3 text-right font-mono">{stats.completed}</td>
                      <td className="px-4 py-3 text-right font-mono">{stats.failed}</td>
                      <td className="px-4 py-3 text-right font-mono">{stats.delayed}</td>
                      <td className="px-4 py-3 text-right font-mono">
                        {stats.lag.toLocaleString()}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
