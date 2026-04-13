import { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Card } from './ui/card.js';

interface CoverageRow {
  namespace: string;
  total: number;
  embedded: number;
  coverage: number;
}

export function EmbeddingStatusPanel() {
  const [rows, setRows] = useState<CoverageRow[]>([]);
  const [vectorEnabled, setVectorEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const status = await api.embeddingStatus();
      setVectorEnabled(status.vectorEnabled);
      setRows(status.byNamespace);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function rebuild(namespace?: string): Promise<void> {
    const label = namespace ?? '(all)';
    setRebuilding(label);
    setError(null);
    try {
      const summary = await api.rebuildEmbeddings({
        namespace,
        dimensions: vectorEnabled ? undefined : 768,
      });
      setLastSummary(
        `Rebuilt ${namespace ?? 'all namespaces'}: ${summary.embedded} embedded, ${summary.skipped} skipped, ${summary.errors} errors (${summary.durationMs}ms)`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rebuild failed');
    } finally {
      setRebuilding(null);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 flex items-center gap-2 font-medium text-zinc-200">
        <Sparkles className="h-4 w-4 text-indigo-400" />
        Embeddings
        <button
          onClick={() => void refresh()}
          className="ml-auto text-zinc-500 hover:text-zinc-300"
          title="Refresh embedding status"
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </h2>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {vectorEnabled === false && (
        <p className="mb-3 text-xs text-amber-300">
          Vector search is not enabled on this database. Rebuilding will bootstrap with 768-dim
          vectors.
        </p>
      )}

      {rows.length === 0 && !loading ? (
        <p className="mb-3 text-sm text-zinc-600">No entities yet.</p>
      ) : (
        <div className="mb-3 space-y-2">
          {rows.map((r) => {
            const pct = Math.round(r.coverage * 100);
            return (
              <div key={r.namespace} className="rounded-md bg-zinc-800/50 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-zinc-300">{r.namespace}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500">
                      {r.embedded} / {r.total} ({pct}%)
                    </span>
                    <button
                      onClick={() => void rebuild(r.namespace)}
                      disabled={rebuilding !== null}
                      className="flex items-center gap-1 rounded bg-indigo-700 px-2 py-0.5 text-xs text-zinc-100 hover:bg-indigo-600 disabled:opacity-50"
                    >
                      {rebuilding === r.namespace && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      Rebuild
                    </button>
                  </div>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-zinc-900">
                  <div
                    className="h-full bg-indigo-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={() => void rebuild()}
        disabled={rebuilding !== null}
        className="flex items-center gap-1 rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
      >
        {rebuilding === '(all)' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Rebuild all namespaces
      </button>

      {lastSummary && <p className="mt-2 text-xs text-zinc-500">{lastSummary}</p>}
    </Card>
  );
}
