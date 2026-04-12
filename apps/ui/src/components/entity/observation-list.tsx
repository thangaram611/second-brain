import { useState, useOptimistic } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';

interface ObservationListProps {
  observations: string[];
  onAdd: (observation: string) => void;
  onRemove: (observation: string) => void;
  readOnly?: boolean;
}

type OptimisticAction =
  | { type: 'add'; observation: string }
  | { type: 'remove'; observation: string };

export function ObservationList({ observations, onAdd, onRemove, readOnly }: ObservationListProps) {
  const [newObs, setNewObs] = useState('');

  const [optimisticObs, dispatchOptimistic] = useOptimistic(
    observations,
    (current: string[], action: OptimisticAction) => {
      if (action.type === 'add') return [...current, action.observation];
      return current.filter((o) => o !== action.observation);
    },
  );

  function handleAdd() {
    const trimmed = newObs.trim();
    if (!trimmed) return;
    dispatchOptimistic({ type: 'add', observation: trimmed });
    onAdd(trimmed);
    setNewObs('');
  }

  function handleRemove(obs: string) {
    dispatchOptimistic({ type: 'remove', observation: obs });
    onRemove(obs);
  }

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        Observations ({optimisticObs.length})
      </h3>

      {optimisticObs.length === 0 ? (
        <p className="text-sm text-zinc-600">No observations yet</p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {optimisticObs.map((obs, i) => (
            <li key={i} className="group flex items-start gap-2 text-sm text-zinc-300">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
              <span className="flex-1">{obs}</span>
              {!readOnly && (
                <button
                  onClick={() => handleRemove(obs)}
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  title="Remove observation"
                >
                  <X className="h-3.5 w-3.5 text-zinc-600 hover:text-red-400" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="flex gap-2">
          <Input
            value={newObs}
            onChange={(e) => setNewObs(e.target.value)}
            placeholder="Add an observation..."
            className="text-xs"
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <Button onClick={handleAdd} size="sm" variant="secondary" disabled={!newObs.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
