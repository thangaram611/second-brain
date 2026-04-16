import { useEffect } from 'react';
import { Users, FolderOpen, FileText, ChevronRight, RefreshCw } from 'lucide-react';
import { useOwnershipStore } from '../../store/ownership-store.js';
import type { OwnershipNode } from '../../store/ownership-store.js';
import { Card } from '../ui/card.js';
import { EmptyState } from '../ui/empty-state.js';
import { LoadingState } from '../ui/loading.js';
import { Button } from '../ui/button.js';

function ScoreBar({ score }: { score: number }) {
  const color = score > 0.7 ? 'bg-emerald-500' : score > 0.3 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-zinc-800">
        <div
          className={`h-2 rounded-full ${color}`}
          style={{ width: `${Math.max(0, Math.min(100, score * 100))}%` }}
        />
      </div>
      <span className="text-xs text-zinc-500">{(score * 100).toFixed(0)}%</span>
    </div>
  );
}

function NodeRow({ node, onNavigate }: { node: OwnershipNode; onNavigate: (path: string) => void }) {
  const topOwner = node.owners?.[0];

  return (
    <tr className="border-t border-zinc-800">
      <td className="px-4 py-2">
        {node.isDir ? (
          <button
            className="flex items-center gap-2 text-sm text-zinc-200 hover:text-indigo-400"
            onClick={() => onNavigate(node.path)}
          >
            <FolderOpen className="h-4 w-4 text-amber-500" />
            {node.name}
          </button>
        ) : (
          <span className="flex items-center gap-2 text-sm text-zinc-400">
            <FileText className="h-4 w-4 text-zinc-600" />
            {node.name}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-sm text-zinc-400">
        {topOwner ? topOwner.actor : <span className="text-zinc-600">—</span>}
      </td>
      <td className="px-4 py-2">
        {topOwner ? <ScoreBar score={topOwner.score} /> : <span className="text-xs text-zinc-600">—</span>}
      </td>
    </tr>
  );
}

export function OwnershipPage() {
  const { tree, loading, error, breadcrumbs, fetchTree, navigateTo } = useOwnershipStore();

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-100">Ownership</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => fetchTree(useOwnershipStore.getState().selectedPath)}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {/* Breadcrumbs */}
      <nav className="mb-4 flex items-center gap-1 text-sm text-zinc-500">
        {breadcrumbs.map((segment, i) => {
          const path = i === 0 ? '.' : breadcrumbs.slice(1, i + 1).join('/');
          const isLast = i === breadcrumbs.length - 1;
          return (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
              {isLast ? (
                <span className="text-zinc-300">{segment}</span>
              ) : (
                <button
                  className="hover:text-indigo-400"
                  onClick={() => navigateTo(path)}
                >
                  {segment}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      {loading && <LoadingState message="Loading ownership data..." />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && (!tree || (tree.children && tree.children.length === 0)) && (
        <EmptyState
          icon={<Users className="h-12 w-12" />}
          title="No ownership data"
          description="Ownership is computed from git history. Make sure this directory has tracked files."
        />
      )}

      {!loading && !error && tree && tree.children && tree.children.length > 0 && (
        <Card>
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-600">
                <th className="px-4 py-2">File / Dir</th>
                <th className="px-4 py-2">Top Owner</th>
                <th className="px-4 py-2">Score</th>
              </tr>
            </thead>
            <tbody>
              {tree.children.map((child) => (
                <NodeRow key={child.path} node={child} onNavigate={navigateTo} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
