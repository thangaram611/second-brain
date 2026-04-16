import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Brain, exportPersonal } from '@second-brain/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runPersonalExport, runPersonalImport, runPersonalStats } from '../personal.js';

function makeBrain(): Brain {
  return new Brain({ path: ':memory:', wal: false });
}

function seedPersonalEntities(brain: Brain): void {
  brain.entities.batchUpsert([
    {
      type: 'concept',
      name: 'TypeScript',
      namespace: 'personal',
      observations: ['Prefers strict mode'],
      properties: {},
      confidence: 0.9,
      source: { type: 'personality', ref: 'preferences' },
    },
    {
      type: 'concept',
      name: 'Vim keybindings',
      namespace: 'personal',
      observations: ['Uses Vim keybindings in VS Code'],
      properties: {},
      confidence: 0.8,
      source: { type: 'personality', ref: 'tools' },
    },
    {
      type: 'concept',
      name: 'TDD',
      namespace: 'personal',
      observations: ['Practices test-driven development'],
      properties: {},
      confidence: 0.85,
      source: { type: 'conversation', ref: 'chat-1' },
    },
  ]);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPersonalExport', () => {
  it('writes valid JSON bundle file', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);
    const outFile = path.join(os.tmpdir(), `personal-export-${Date.now()}.json`);

    try {
      await runPersonalExport(brain, { out: outFile });
      const content = fs.readFileSync(outFile, 'utf-8');
      const bundle = JSON.parse(content);

      expect(bundle.version).toBe('1.0');
      expect(bundle.entities).toHaveLength(3);
      expect(bundle.relations).toBeInstanceOf(Array);
      expect(bundle.sha256).toBeDefined();
      expect(bundle.manifest.danglingEntityIds).toBeInstanceOf(Array);
    } finally {
      brain.close();
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });

  it('outputs JSON summary with --json flag', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);
    const outFile = path.join(os.tmpdir(), `personal-export-json-${Date.now()}.json`);

    try {
      await runPersonalExport(brain, { out: outFile, json: true });
      expect(logSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(output.entities).toBe(3);
      expect(output.encrypted).toBe(false);
      expect(output.file).toBe(outFile);
    } finally {
      brain.close();
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });

  it('prints human-readable summary without --json', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);
    const outFile = path.join(os.tmpdir(), `personal-export-text-${Date.now()}.json`);

    try {
      await runPersonalExport(brain, { out: outFile });
      const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(allOutput).toContain('Exported 3 entities');
      expect(allOutput).toContain('Written to:');
    } finally {
      brain.close();
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });
});

describe('runPersonalImport', () => {
  it('reads exported file and imports entities', async () => {
    const brain1 = makeBrain();
    seedPersonalEntities(brain1);
    const outFile = path.join(os.tmpdir(), `personal-roundtrip-${Date.now()}.json`);

    try {
      await runPersonalExport(brain1, { out: outFile });
      brain1.close();

      const brain2 = makeBrain();
      try {
        await runPersonalImport(brain2, { file: outFile });
        const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
        expect(allOutput).toContain('Imported 3 entities');
      } finally {
        brain2.close();
      }
    } finally {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });

  it('outputs JSON result with --json flag', async () => {
    const brain1 = makeBrain();
    seedPersonalEntities(brain1);
    const outFile = path.join(os.tmpdir(), `personal-import-json-${Date.now()}.json`);

    try {
      await runPersonalExport(brain1, { out: outFile });
      brain1.close();

      logSpy.mockClear();

      const brain2 = makeBrain();
      try {
        await runPersonalImport(brain2, { file: outFile, json: true });
        expect(logSpy).toHaveBeenCalled();
        const result = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1]![0] as string);
        expect(result.entitiesImported).toBe(3);
        expect(result.relationsImported).toBe(0);
      } finally {
        brain2.close();
      }
    } finally {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });

  it('rejects bundles with wrong version', async () => {
    const outFile = path.join(os.tmpdir(), `personal-badver-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ version: '99.0' }));
    const brain = makeBrain();

    try {
      await expect(
        runPersonalImport(brain, { file: outFile }),
      ).rejects.toThrow('process.exit');
      expect(errorSpy).toHaveBeenCalledWith('Unsupported bundle version: 99.0');
    } finally {
      brain.close();
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });
});

describe('runPersonalStats', () => {
  it('shows counts for personal namespace', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);

    try {
      await runPersonalStats(brain, {});
      const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(allOutput).toContain('Entities: 3');
      expect(allOutput).toContain('Relations: 0');
    } finally {
      brain.close();
    }
  });

  it('outputs JSON with --json flag', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);

    try {
      await runPersonalStats(brain, { json: true });
      expect(logSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(output.stats.totalEntities).toBe(3);
      expect(output.sourceTypes).toBeInstanceOf(Array);
      expect(output.streams).toBeInstanceOf(Array);
    } finally {
      brain.close();
    }
  });

  it('shows per-source-type breakdown', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);

    try {
      await runPersonalStats(brain, {});
      const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(allOutput).toContain('By source type:');
      expect(allOutput).toContain('personality: 2');
      expect(allOutput).toContain('conversation: 1');
    } finally {
      brain.close();
    }
  });

  it('shows audit details with --audit flag', async () => {
    const brain = makeBrain();
    seedPersonalEntities(brain);

    try {
      await runPersonalStats(brain, { audit: true });
      const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(allOutput).toContain('Audit (2 personality entities)');
      expect(allOutput).toContain('[preferences] TypeScript');
      expect(allOutput).toContain('[tools] Vim keybindings');
    } finally {
      brain.close();
    }
  });
});

describe('round-trip', () => {
  it('export → import into fresh brain → stats match', async () => {
    const brain1 = makeBrain();
    seedPersonalEntities(brain1);
    const outFile = path.join(os.tmpdir(), `personal-roundtrip-full-${Date.now()}.json`);

    try {
      await runPersonalExport(brain1, { out: outFile });
      const origStats = brain1.search.getStats('personal');
      brain1.close();

      const brain2 = makeBrain();
      try {
        await runPersonalImport(brain2, { file: outFile });
        const newStats = brain2.search.getStats('personal');
        expect(newStats.totalEntities).toBe(origStats.totalEntities);
        expect(newStats.totalRelations).toBe(origStats.totalRelations);
      } finally {
        brain2.close();
      }
    } finally {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });

  it('import with reattach=false drops dangling edges', async () => {
    const brain1 = makeBrain();
    seedPersonalEntities(brain1);

    // Create a relation pointing to a non-personal entity (simulating cross-namespace)
    const entities = brain1.entities.list({ namespace: 'personal', limit: 10 });
    const projectEntity = brain1.entities.batchUpsert([{
      type: 'file',
      name: 'src/main.ts',
      namespace: 'project-x',
      observations: ['Main file'],
      properties: {},
      confidence: 1.0,
      source: { type: 'git' },
    }]);
    brain1.relations.batchUpsert([{
      type: 'relates_to',
      sourceId: entities[0]!.id,
      targetId: projectEntity[0]!.id,
      namespace: 'personal',
      properties: {},
      confidence: 1.0,
      source: { type: 'personality' },
    }]);

    const outFile = path.join(os.tmpdir(), `personal-dangling-${Date.now()}.json`);

    try {
      await runPersonalExport(brain1, { out: outFile });
      brain1.close();

      logSpy.mockClear();

      const brain2 = makeBrain();
      try {
        await runPersonalImport(brain2, { file: outFile, reattach: false });
        const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
        expect(allOutput).toContain('Dropped');
        expect(allOutput).toContain('dangling edges');
      } finally {
        brain2.close();
      }
    } finally {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });
});
