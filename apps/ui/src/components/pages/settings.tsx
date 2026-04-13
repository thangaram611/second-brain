import { useEffect, useState } from 'react';
import { Database, Server, Cpu, RefreshCw, Users } from 'lucide-react';
import { useStatsStore } from '../../store/stats-store.js';
import { useSyncStore } from '../../store/sync-store.js';
import { Card } from '../ui/card.js';
import { EmbeddingStatusPanel } from '../embedding-status-panel.js';
import type { SyncConnectionState } from '../../lib/types.js';

function SyncDot({ state }: { state: SyncConnectionState }) {
  const colors: Record<SyncConnectionState, string> = {
    connected: 'bg-emerald-400',
    syncing: 'bg-amber-400',
    connecting: 'bg-amber-400',
    disconnected: 'bg-zinc-600',
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[state]}`} />;
}

export function SettingsPage() {
  const { stats, fetchStats } = useStatsStore();
  const { statuses, loading: syncLoading, error: syncError, fetchStatuses, joinSync, leaveSync } = useSyncStore();

  const [joinNamespace, setJoinNamespace] = useState('');
  const [joinRelayUrl, setJoinRelayUrl] = useState('ws://localhost:7421');
  const [joinToken, setJoinToken] = useState('');

  useEffect(() => {
    fetchStats();
    fetchStatuses();
  }, [fetchStats, fetchStatuses]);

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinNamespace || !joinRelayUrl || !joinToken) return;
    joinSync({ namespace: joinNamespace, relayUrl: joinRelayUrl, token: joinToken });
    setJoinNamespace('');
    setJoinToken('');
  }

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

        <EmbeddingStatusPanel />

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

        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-medium text-zinc-200">
            <Users className="h-4 w-4 text-cyan-400" />
            Team Sync
            <button
              onClick={() => fetchStatuses()}
              className="ml-auto text-zinc-500 hover:text-zinc-300"
              title="Refresh sync status"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncLoading ? 'animate-spin' : ''}`} />
            </button>
          </h2>

          {syncError && (
            <p className="mb-3 text-sm text-red-400">{syncError}</p>
          )}

          {statuses.length === 0 ? (
            <p className="mb-4 text-sm text-zinc-600">No synced namespaces</p>
          ) : (
            <div className="mb-4 space-y-2">
              {statuses.map((st) => (
                <div
                  key={st.namespace}
                  className="flex items-center justify-between rounded-md bg-zinc-800/50 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <SyncDot state={st.state} />
                    <span className="font-mono text-zinc-300">{st.namespace}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-zinc-500">
                      {st.connectedPeers} peer{st.connectedPeers !== 1 ? 's' : ''}
                    </span>
                    {st.lastSyncedAt && (
                      <span className="text-zinc-600 text-xs">
                        last sync {new Date(st.lastSyncedAt).toLocaleTimeString()}
                      </span>
                    )}
                    <button
                      onClick={() => leaveSync(st.namespace)}
                      className="rounded bg-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-600"
                    >
                      Leave
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleJoin} className="space-y-2">
            <p className="text-xs font-medium text-zinc-500">Join a sync namespace</p>
            <input
              type="text"
              placeholder="Namespace"
              value={joinNamespace}
              onChange={(e) => setJoinNamespace(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Relay URL"
              value={joinRelayUrl}
              onChange={(e) => setJoinRelayUrl(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Token"
              value={joinToken}
              onChange={(e) => setJoinToken(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!joinNamespace || !joinRelayUrl || !joinToken || syncLoading}
              className="rounded-md bg-cyan-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-cyan-600 disabled:opacity-50"
            >
              Join
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
