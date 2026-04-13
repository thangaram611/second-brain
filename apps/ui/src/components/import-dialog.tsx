import { useState } from 'react';
import { X, Upload, FileCode } from 'lucide-react';
import { api } from '../lib/api.js';

type ImportFormat = 'json' | 'json-ld';
type ImportStrategy = 'replace' | 'merge' | 'upsert';

interface ImportResult {
  entitiesImported: number;
  relationsImported: number;
  conflicts: Array<{ entityType: string; entityName: string; reason: string }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ImportDialog({ open, onClose }: Props) {
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [format, setFormat] = useState<ImportFormat>('json');
  const [strategy, setStrategy] = useState<ImportStrategy>('upsert');
  const [namespace, setNamespace] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  function reset(): void {
    setContent('');
    setFileName(null);
    setFormat('json');
    setStrategy('upsert');
    setNamespace('');
    setResult(null);
    setError(null);
    setRunning(false);
  }

  async function handleFile(file: File): Promise<void> {
    setFileName(file.name);
    if (file.name.endsWith('.jsonld')) setFormat('json-ld');
    else if (file.name.endsWith('.json')) setFormat('json');
    const text = await file.text();
    setContent(text);
  }

  async function submit(): Promise<void> {
    if (!content.trim()) {
      setError('Paste or select a graph file first.');
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const out = await api.import({
        content,
        format,
        strategy,
        namespace: namespace.trim() || undefined,
      });
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setRunning(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Upload className="h-5 w-5 text-indigo-400" />
            Import graph
          </h2>
          <button
            onClick={() => {
              reset();
              onClose();
            }}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-zinc-700 bg-zinc-800/30 px-4 py-3 text-sm text-zinc-400 hover:border-indigo-500 hover:text-zinc-200">
            <FileCode className="h-4 w-4" />
            {fileName ? (
              <span className="truncate font-mono text-zinc-300">{fileName}</span>
            ) : (
              <span>Choose a .json or .jsonld file…</span>
            )}
            <input
              type="file"
              accept=".json,.jsonld"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </label>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Format</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as ImportFormat)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-200"
              >
                <option value="json">json</option>
                <option value="json-ld">json-ld</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Strategy</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as ImportStrategy)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-200"
              >
                <option value="upsert">upsert</option>
                <option value="merge">merge</option>
                <option value="replace">replace</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Namespace override</label>
              <input
                type="text"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="(keep original)"
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-200 placeholder-zinc-600"
              />
            </div>
          </div>

          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Preview / paste JSON</summary>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder='{"entities":[],"relations":[]}'
              className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder-zinc-600"
            />
          </details>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {result && (
            <div className="rounded-md border border-emerald-900/60 bg-emerald-900/10 p-3 text-sm text-emerald-200">
              Imported <strong>{result.entitiesImported}</strong> entities and{' '}
              <strong>{result.relationsImported}</strong> relations.
              {result.conflicts.length > 0 && (
                <p className="mt-1 text-xs text-amber-300">
                  {result.conflicts.length} conflict
                  {result.conflicts.length !== 1 ? 's' : ''} (first: {result.conflicts[0].entityType}/
                  {result.conflicts[0].entityName}: {result.conflicts[0].reason})
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                reset();
                onClose();
              }}
              className="rounded-md bg-zinc-800 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
            >
              {result ? 'Close' : 'Cancel'}
            </button>
            <button
              onClick={submit}
              disabled={running || !content.trim()}
              className="rounded-md bg-indigo-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-indigo-600 disabled:opacity-50"
            >
              {running ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
