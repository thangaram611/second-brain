import { useEffect, useState } from 'react';
import { Database, Server, Cpu, RefreshCw, Users, Key, Copy, Check, LogOut } from 'lucide-react';
import { useStatsStore } from '../../store/stats-store.js';
import { useSyncStore, DEFAULT_RELAY_URL } from '../../store/sync-store.js';
import { useAuthStore } from '../../store/auth-store.js';
import { api } from '../../lib/api.js';
import { Card } from '../ui/card.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
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
  const user = useAuthStore((s) => s.user);
  const mode = useAuthStore((s) => s.mode);
  const relayUrl = useAuthStore((s) => s.relayUrl);
  const logout = useAuthStore((s) => s.logout);

  const [joinNamespace, setJoinNamespace] = useState('');
  const [joinToken, setJoinToken] = useState('');

  // PAT rotation state — the new PAT is only shown ONCE, then cleared.
  const [rotatedPat, setRotatedPat] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchStats();
    fetchStatuses();
  }, [fetchStats, fetchStatuses]);

  const effectiveRelayUrl = relayUrl ?? DEFAULT_RELAY_URL;

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinNamespace || !joinToken) return;
    // relayUrl is taken from auth-store / whoami; sync-store falls back
    // to the default if it's not set yet.
    joinSync({ namespace: joinNamespace, token: joinToken });
    setJoinNamespace('');
    setJoinToken('');
  }

  async function handleRotate() {
    setRotating(true);
    setRotateError(null);
    setRotatedPat(null);
    setCopied(false);
    try {
      const result = await api.auth.rotatePat();
      setRotatedPat(result.pat);
    } catch (e) {
      setRotateError(e instanceof Error ? e.message : 'Failed to rotate PAT');
    } finally {
      setRotating(false);
    }
  }

  async function handleCopy() {
    if (!rotatedPat) return;
    try {
      await navigator.clipboard.writeText(rotatedPat);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable in non-secure contexts; ignore.
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-zinc-100">Settings</h1>

      <div className="space-y-4">
        {mode === 'pat' && user && (
          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-medium text-zinc-200">
              <Key className="h-4 w-4 text-fuchsia-400" />
              Account
              <button
                onClick={() => void logout()}
                className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                title="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Email</dt>
                <dd className="text-zinc-300">{user.email}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">User ID</dt>
                <dd className="font-mono text-xs text-zinc-400">{user.id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Namespace</dt>
                <dd className="font-mono text-zinc-300">{user.namespace}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Relay URL</dt>
                <dd className="font-mono text-xs text-zinc-300">{effectiveRelayUrl}</dd>
              </div>
            </dl>

            <div className="mt-4 border-t border-zinc-800 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-200">Rotate Personal Access Token</p>
                  <p className="text-xs text-zinc-500">
                    Mints a new PAT and revokes the current one.
                  </p>
                </div>
                <Button
                  onClick={() => void handleRotate()}
                  disabled={rotating}
                  variant="secondary"
                  size="sm"
                >
                  {rotating ? 'Rotating...' : 'Rotate PAT'}
                </Button>
              </div>

              {rotateError && (
                <p className="mt-3 text-xs text-red-400" role="alert">
                  {rotateError}
                </p>
              )}

              {rotatedPat && (
                <div
                  className="mt-3 rounded-md border border-amber-700/50 bg-amber-900/10 p-3"
                  role="status"
                  aria-live="polite"
                >
                  <p className="mb-2 text-xs font-medium text-amber-300">
                    New PAT — copy it now. It will not be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200">
                      {rotatedPat}
                    </code>
                    <button
                      onClick={() => void handleCopy()}
                      className="inline-flex items-center gap-1 rounded-md bg-zinc-700 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600"
                      title="Copy to clipboard"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

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
            <div className="flex justify-between">
              <dt className="text-zinc-500">Relay</dt>
              <dd className="font-mono text-zinc-300">{effectiveRelayUrl}</dd>
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
            <p className="text-xs font-medium text-zinc-500">
              Join a sync namespace (relay <code className="font-mono">{effectiveRelayUrl}</code>)
            </p>
            <Input
              type="text"
              placeholder="Namespace"
              value={joinNamespace}
              onChange={(e) => setJoinNamespace(e.target.value)}
            />
            <Input
              type="password"
              placeholder="Token"
              value={joinToken}
              onChange={(e) => setJoinToken(e.target.value)}
            />
            <Button
              type="submit"
              disabled={!joinNamespace || !joinToken || syncLoading}
              size="sm"
            >
              Join
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
