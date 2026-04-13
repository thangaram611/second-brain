import { useState } from 'react';
import { Sparkles, Send } from 'lucide-react';
import { api } from '../lib/api.js';
import type { SearchResult } from '../lib/types.js';
import { Card } from './ui/card.js';
import { TypeBadge } from './ui/badge.js';

interface ChatTurn {
  question: string;
  interpreted: string | null;
  results: SearchResult[];
  error?: string;
}

interface Props {
  namespace?: string;
  onSelect?: (entityId: string) => void;
}

export function QueryChatPanel({ namespace, onSelect }: Props) {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);

  async function submit(): Promise<void> {
    const question = input.trim();
    if (!question || loading) return;
    setLoading(true);
    const placeholder: ChatTurn = { question, interpreted: null, results: [] };
    setTurns((ts) => [...ts, placeholder]);
    setInput('');
    try {
      const response = await api.query({ question, namespace, limit: 8 });
      setTurns((ts) => {
        const next = [...ts];
        next[next.length - 1] = {
          question,
          interpreted: response.interpreted,
          results: response.results,
        };
        return next;
      });
    } catch (e) {
      setTurns((ts) => {
        const next = [...ts];
        next[next.length - 1] = {
          ...placeholder,
          error: e instanceof Error ? e.message : 'Query failed',
        };
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <Sparkles className="h-4 w-4 text-indigo-400" />
        Ask your brain
      </h2>

      {turns.length === 0 ? (
        <p className="text-xs text-zinc-500">
          Ask a natural-language question. Your configured LLM (if any) reshapes it into keywords
          and the server runs the multi-channel search.
        </p>
      ) : (
        <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: 360 }}>
          {turns.map((turn, i) => (
            <div key={i} className="space-y-1.5">
              <div className="rounded-md bg-zinc-800/60 px-3 py-2 text-sm text-zinc-200">
                {turn.question}
              </div>
              {turn.interpreted && (
                <p className="px-3 text-xs text-zinc-500">
                  interpreted as: <span className="font-mono text-zinc-400">{turn.interpreted}</span>
                </p>
              )}
              {turn.error ? (
                <p className="px-3 text-xs text-red-400">{turn.error}</p>
              ) : turn.results.length === 0 && !loading ? (
                <p className="px-3 text-xs text-zinc-600">No matches.</p>
              ) : (
                <ul className="space-y-1">
                  {turn.results.map((r) => (
                    <li key={r.entity.id}>
                      <button
                        type="button"
                        onClick={() => onSelect?.(r.entity.id)}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs hover:bg-zinc-800/60"
                      >
                        <TypeBadge type={r.entity.type} />
                        <span className="flex-1 truncate text-zinc-200">{r.entity.name}</span>
                        <span className="text-zinc-600">{r.score.toFixed(2)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…"
          disabled={loading}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-600 focus:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="flex items-center gap-1 rounded-md bg-indigo-700 px-3 py-1.5 text-sm font-medium text-zinc-100 hover:bg-indigo-600 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          Ask
        </button>
      </form>
    </Card>
  );
}
