import { useEffect, useRef } from 'react';
import { Radio, GitBranch, User, RefreshCw } from 'lucide-react';
import { useWipStore } from '../../store/wip-store.js';
import type { ParallelWorkConflict } from '../../store/wip-store.js';
import { Card } from '../ui/card.js';
import { EmptyState } from '../ui/empty-state.js';
import { LoadingState } from '../ui/loading.js';
import { Button } from '../ui/button.js';

const AUTO_REFRESH_MS = 30_000;
const FRESH_THRESHOLD_MS = 35_000;

function severityColor(branchCount: number): string {
  if (branchCount >= 3) return 'bg-red-500/20 text-red-400';
  return 'bg-yellow-500/20 text-yellow-400';
}

function ConnectionDot({ lastFetched }: { lastFetched: string | null }) {
  const fresh =
    lastFetched != null &&
    Date.now() - new Date(lastFetched).getTime() < FRESH_THRESHOLD_MS;
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${fresh ? 'bg-green-500' : 'bg-yellow-500'}`}
      title={fresh ? 'Connected — data is fresh' : 'Data may be stale'}
    />
  );
}

function ConflictCard({ conflict }: { conflict: ParallelWorkConflict }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">{conflict.entityName}</span>
          <span className="inline-flex items-center rounded-full bg-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-300">
            {conflict.entityType}
          </span>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityColor(conflict.branches.length)}`}
        >
          {conflict.branches.length} branches
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-zinc-800/50 p-3">
          <div className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-zinc-600">
            <GitBranch className="h-3 w-3" /> Branches
          </div>
          <ul className="space-y-1">
            {conflict.branches.map((branch) => (
              <li key={branch} className="text-sm text-zinc-300">
                {branch}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg bg-zinc-800/50 p-3">
          <div className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-zinc-600">
            <User className="h-3 w-3" /> Authors
          </div>
          <ul className="space-y-1">
            {conflict.actors.map((actor) => (
              <li key={actor} className="text-sm text-zinc-300">
                {actor}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {conflict.namespace && (
        <div className="mt-2 text-xs text-zinc-600">
          Namespace: {conflict.namespace}
        </div>
      )}
    </Card>
  );
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function WipRadarPage() {
  const { conflicts, loading, error, lastFetched, fetch } = useWipStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch();
    intervalRef.current = setInterval(() => {
      fetch();
    }, AUTO_REFRESH_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetch]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-100">WIP Radar</h1>
          <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
            {conflicts.length}
          </span>
          <ConnectionDot lastFetched={lastFetched} />
        </div>
        <div className="flex items-center gap-3">
          {lastFetched && (
            <span className="text-xs text-zinc-500">
              Last updated: {timeAgo(lastFetched)}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={fetch}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      {loading && conflicts.length === 0 && (
        <LoadingState message="Scanning for parallel work..." />
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && conflicts.length === 0 && (
        <EmptyState
          icon={<Radio className="h-12 w-12" />}
          title="No parallel work detected"
          description="When multiple branches modify the same files, conflicts will appear here."
        />
      )}

      {conflicts.length > 0 && (
        <div className="space-y-4">
          {conflicts.map((c) => (
            <ConflictCard key={c.entityId} conflict={c} />
          ))}
        </div>
      )}
    </div>
  );
}
