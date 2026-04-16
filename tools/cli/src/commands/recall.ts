import type { Command } from 'commander';
import { openBrain } from '../lib/config.js';

export function registerRecallCommand(program: Command): void {
  program
    .command('recall')
    .description('Build a context block mimicking what SessionStart would inject')
    .option('-s, --session <id>', 'Session ID to include session:<id> in scope')
    .option('-q, --query <text>', 'Optional free-text query')
    .option('-n, --namespace <ns>', 'Additional namespace (repeatable)', (val, prev: string[]) => [...(prev ?? []), val], [] as string[])
    .option('-l, --limit <n>', 'Max entities', '15')
    .action(async (options: { session?: string; query?: string; namespace: string[]; limit: string }) => {
      const brain = openBrain();
      try {
        const namespaces = options.namespace.length > 0 ? options.namespace : ['personal'];
        const scope = Array.from(
          new Set([
            ...(options.session ? [`session:${options.session}`] : []),
            ...namespaces,
          ]),
        );
        const limit = parseInt(options.limit, 10);

        let hits: Array<{ entity: { id: string; type: string; name: string; namespace: string; observations: string[]; confidence: number; lastAccessedAt: string } }> = [];
        if (options.query && options.query.trim()) {
          const merged = new Map<string, { entity: { id: string; type: string; name: string; namespace: string; observations: string[]; confidence: number; lastAccessedAt: string }; score: number }>();
          for (const ns of scope) {
            const res = await brain.search.searchMulti({ query: options.query, namespace: ns, limit: limit * 2 });
            for (const r of res) {
              const prev = merged.get(r.entity.id);
              if (!prev || r.score > prev.score) merged.set(r.entity.id, r);
            }
          }
          hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((r) => ({ entity: r.entity }));
        } else {
          for (const ns of scope) {
            const list = brain.entities.list({ namespace: ns, limit: limit * 2 });
            list.sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
            for (const entity of list.slice(0, limit)) hits.push({ entity });
          }
          hits = hits.slice(0, limit);
        }
        if (hits.length === 0) {
          console.log('No prior context.');
          return;
        }
        console.log('## Prior context from second-brain');
        for (const h of hits) {
          const e = h.entity;
          console.log(`- [${e.type}] ${e.name} · ${e.id} · ns=${e.namespace}`);
          if (e.observations.length > 0) console.log(`  - ${e.observations[0]}`);
        }
      } finally {
        brain.close();
      }
    });
}
