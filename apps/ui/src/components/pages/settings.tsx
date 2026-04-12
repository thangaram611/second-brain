import { useEffect } from 'react';
import { Database, Server, Cpu } from 'lucide-react';
import { useStatsStore } from '../../store/stats-store.js';
import { Card } from '../ui/card.js';

export function SettingsPage() {
  const { stats, fetchStats } = useStatsStore();

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-zinc-100">Settings</h1>

      <div className="space-y-4">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-medium text-zinc-200">
            <Database className="h-4 w-4 text-indigo-400" />
            Database
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Path</dt>
              <dd className="font-mono text-zinc-300">~/.second-brain/personal.db</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Total Entities</dt>
              <dd className="text-zinc-300">{stats?.totalEntities ?? '-'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Total Relations</dt>
              <dd className="text-zinc-300">{stats?.totalRelations ?? '-'}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-medium text-zinc-200">
            <Server className="h-4 w-4 text-emerald-400" />
            API Server
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">REST API</dt>
              <dd className="font-mono text-zinc-300">http://localhost:7430</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">MCP Server</dt>
              <dd className="font-mono text-zinc-300">http://localhost:7420</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">WebSocket</dt>
              <dd className="font-mono text-zinc-300">ws://localhost:7430/ws</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-medium text-zinc-200">
            <Cpu className="h-4 w-4 text-amber-400" />
            Namespaces
          </h2>
          {stats?.namespaces.length ? (
            <div className="flex flex-wrap gap-2">
              {stats.namespaces.map((ns) => (
                <span
                  key={ns}
                  className="rounded-full bg-zinc-800 px-3 py-1 text-sm text-zinc-300"
                >
                  {ns}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No namespaces yet</p>
          )}
        </Card>
      </div>
    </div>
  );
}
