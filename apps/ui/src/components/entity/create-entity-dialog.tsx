import { useActionState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { useGraphStore } from '../../store/graph-store.js';
import { ENTITY_TYPES } from '../../lib/types.js';

interface CreateEntityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FormState {
  error: string | null;
}

export function CreateEntityDialog({ open, onOpenChange }: CreateEntityDialogProps) {
  const createEntity = useGraphStore((s) => s.createEntity);

  const [state, formAction, isPending] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const name = (formData.get('name') as string | null)?.trim();
      if (!name) return { error: 'Name is required' };

      const type = formData.get('type') as string;
      const observationRaw = (formData.get('observation') as string | null)?.trim();
      const tagsRaw = (formData.get('tags') as string | null) ?? '';

      const observations = observationRaw ? [observationRaw] : [];
      const tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      await createEntity({ type, name, observations, tags });
      onOpenChange(false);
      return { error: null };
    },
    { error: null },
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-zinc-100">
              Create Entity
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-zinc-500 hover:text-zinc-300">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <form action={formAction} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Type</label>
              <select
                name="type"
                defaultValue="concept"
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Name</label>
              <Input
                name="name"
                placeholder="Entity name"
                autoFocus
                required
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Initial Observation (optional)
              </label>
              <Input
                name="observation"
                placeholder="An atomic fact about this entity"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Tags (comma-separated, optional)
              </label>
              <Input
                name="tags"
                placeholder="tag1, tag2, tag3"
              />
            </div>

            {state.error && (
              <p className="text-sm text-red-400">{state.error}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
