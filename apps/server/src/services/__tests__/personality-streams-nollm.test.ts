import { describe, it, expect, afterEach, vi } from 'vitest';
import { Brain } from '@second-brain/core';
import type { PersonalityContext } from '../personality-extractor.js';
import { LanguageFingerprintStream } from '../personality/language-fingerprint.js';
import { TechFamiliarityStream } from '../personality/tech-familiarity.js';
import { ManagementSignalsStream } from '../personality/management-signals.js';

const ACTOR = 'test-user';
const NOW = new Date('2025-01-15T00:00:00Z');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeBrain(): Brain {
  return new Brain({ path: ':memory:', wal: false });
}

function makeCtx(brain: Brain): PersonalityContext {
  return { brain, actor: ACTOR, llm: null, logger: silentLogger, now: NOW };
}

/** Insert an entity via raw SQL so we can set source_actor directly. */
function insertEntity(
  brain: Brain,
  overrides: {
    id: string;
    type: string;
    name: string;
    namespace: string;
    sourceActor: string;
    observations?: string[];
  },
): void {
  const now = NOW.toISOString();
  brain.storage.sqlite
    .prepare(
      `INSERT INTO entities (id, type, name, namespace, observations, properties, confidence,
        event_time, ingest_time, last_accessed_at, access_count,
        source_type, source_ref, source_actor, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', 1.0, ?, ?, ?, 0, 'gitlab', 'ref', ?, '[]', ?, ?)`,
    )
    .run(
      overrides.id,
      overrides.type,
      overrides.name,
      overrides.namespace,
      JSON.stringify(overrides.observations ?? []),
      now, now, now,
      overrides.sourceActor,
      now, now,
    );
}

/** Insert a relation via raw SQL so we can set source_actor directly. */
function insertRelation(
  brain: Brain,
  overrides: {
    id: string;
    type: string;
    sourceId: string;
    targetId: string;
    namespace: string;
    sourceActor: string;
    createdAt?: string;
  },
): void {
  const ts = overrides.createdAt ?? NOW.toISOString();
  brain.storage.sqlite
    .prepare(
      `INSERT INTO relations (id, type, source_id, target_id, namespace, properties, confidence,
        weight, bidirectional, source_type, source_ref, source_actor,
        event_time, ingest_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', 1.0, 1.0, 0, 'gitlab', 'ref', ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.id,
      overrides.type,
      overrides.sourceId,
      overrides.targetId,
      overrides.namespace,
      overrides.sourceActor,
      ts, ts, ts, ts,
    );
}

describe('LanguageFingerprintStream', () => {
  let brain: Brain;

  afterEach(() => {
    brain?.close();
  });

  it('generates bigram/trigram stats from MR observations', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    insertEntity(brain, {
      id: 'mr-1',
      type: 'merge_request',
      name: 'Fix auth flow',
      namespace: 'project-a',
      sourceActor: ACTOR,
      observations: ['fix the auth flow in login', 'update login page style'],
    });
    insertEntity(brain, {
      id: 'mr-2',
      type: 'merge_request',
      name: 'Refactor auth',
      namespace: 'project-a',
      sourceActor: ACTOR,
      observations: ['refactor auth flow for security'],
    });

    const stream = new LanguageFingerprintStream();
    const result = await stream.run(ctx);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);

    const facts = brain.entities.findByName('language-fingerprint:project-a', 'personal');
    expect(facts.length).toBe(1);
    const fact = facts[0];
    expect(fact.type).toBe('fact');
    expect(fact.tags).toContain('personality');
    expect(fact.tags).toContain('language-fingerprint');

    const props = fact.properties as Record<string, unknown>;
    expect(props.targetNamespace).toBe('project-a');
    expect(props.sampleSize).toBe(2);
    expect(props.totalTokens).toBeGreaterThan(0);
    expect(Array.isArray(props.bigrams)).toBe(true);
    expect(Array.isArray(props.trigrams)).toBe(true);

    // Verify "auth flow" bigram appears (used in two observations)
    const bigrams = props.bigrams as Array<[string, number]>;
    const authFlow = bigrams.find(([gram]) => gram === 'auth flow');
    expect(authFlow).toBeDefined();
    expect(authFlow![1]).toBeGreaterThanOrEqual(2);
  });

  it('creates nothing when no matching entities exist', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    const stream = new LanguageFingerprintStream();
    const result = await stream.run(ctx);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('upserts on second run (no duplicates)', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    insertEntity(brain, {
      id: 'mr-3',
      type: 'merge_request',
      name: 'Some MR',
      namespace: 'proj-b',
      sourceActor: ACTOR,
      observations: ['add feature to dashboard widget'],
    });

    const stream = new LanguageFingerprintStream();

    const run1 = await stream.run(ctx);
    expect(run1.created).toBe(1);

    const run2 = await stream.run(ctx);
    expect(run2.created).toBe(0);
    expect(run2.updated).toBe(1);

    const facts = brain.entities
      .findByName('language-fingerprint:proj-b', 'personal')
      .filter((e) => e.name === 'language-fingerprint:proj-b');
    expect(facts.length).toBe(1);
  });
});

describe('TechFamiliarityStream', () => {
  let brain: Brain;

  afterEach(() => {
    brain?.close();
  });

  it('counts uses relations and creates fact entities', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    // Target entity (the tech being used)
    insertEntity(brain, {
      id: 'tech-react',
      type: 'tool',
      name: 'React',
      namespace: 'project-x',
      sourceActor: 'system',
    });

    // Source entities that use the tech
    insertEntity(brain, {
      id: 'file-1',
      type: 'file',
      name: 'App.tsx',
      namespace: 'project-x',
      sourceActor: ACTOR,
    });
    insertEntity(brain, {
      id: 'file-2',
      type: 'file',
      name: 'Button.tsx',
      namespace: 'project-x',
      sourceActor: ACTOR,
    });

    insertRelation(brain, {
      id: 'rel-1',
      type: 'uses',
      sourceId: 'file-1',
      targetId: 'tech-react',
      namespace: 'project-x',
      sourceActor: ACTOR,
    });
    insertRelation(brain, {
      id: 'rel-2',
      type: 'uses',
      sourceId: 'file-2',
      targetId: 'tech-react',
      namespace: 'project-x',
      sourceActor: ACTOR,
    });

    const stream = new TechFamiliarityStream();
    const result = await stream.run(ctx);

    expect(result.created).toBe(1);

    const facts = brain.entities
      .findByName('tech-familiarity:React', 'personal')
      .filter((e) => e.name === 'tech-familiarity:React');
    expect(facts.length).toBe(1);

    const props = facts[0].properties as Record<string, unknown>;
    expect(props.tech).toBe('React');
    expect(props.depth).toBe(2);

    // Check derived_from relations were created
    const derivedRels = brain.relations.getOutbound(facts[0].id, 'derived_from');
    expect(derivedRels.length).toBe(2);
  });

  it('limits to top 50 and caps derived_from at 5 per tech', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    // Create a tech target
    insertEntity(brain, {
      id: 'tech-ts',
      type: 'tool',
      name: 'TypeScript',
      namespace: 'proj',
      sourceActor: 'system',
    });

    // Create 8 source entities and uses relations
    for (let i = 0; i < 8; i++) {
      const fileId = `file-ts-${i}`;
      insertEntity(brain, {
        id: fileId,
        type: 'file',
        name: `file${i}.ts`,
        namespace: 'proj',
        sourceActor: ACTOR,
      });
      insertRelation(brain, {
        id: `rel-ts-${i}`,
        type: 'uses',
        sourceId: fileId,
        targetId: 'tech-ts',
        namespace: 'proj',
        sourceActor: ACTOR,
      });
    }

    const stream = new TechFamiliarityStream();
    await stream.run(ctx);

    const facts = brain.entities
      .findByName('tech-familiarity:TypeScript', 'personal')
      .filter((e) => e.name === 'tech-familiarity:TypeScript');
    expect(facts.length).toBe(1);

    // derived_from should be capped at 5
    const derivedRels = brain.relations.getOutbound(facts[0].id, 'derived_from');
    expect(derivedRels.length).toBe(5);
  });

  it('upserts on second run (no duplicates)', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    insertEntity(brain, {
      id: 'tech-vue',
      type: 'tool',
      name: 'Vue',
      namespace: 'proj',
      sourceActor: 'system',
    });
    insertEntity(brain, {
      id: 'file-vue',
      type: 'file',
      name: 'main.vue',
      namespace: 'proj',
      sourceActor: ACTOR,
    });
    insertRelation(brain, {
      id: 'rel-vue',
      type: 'uses',
      sourceId: 'file-vue',
      targetId: 'tech-vue',
      namespace: 'proj',
      sourceActor: ACTOR,
    });

    const stream = new TechFamiliarityStream();

    const run1 = await stream.run(ctx);
    expect(run1.created).toBe(1);

    const run2 = await stream.run(ctx);
    expect(run2.created).toBe(0);
    expect(run2.updated).toBe(1);

    const facts = brain.entities
      .findByName('tech-familiarity:Vue', 'personal')
      .filter((e) => e.name === 'tech-familiarity:Vue');
    expect(facts.length).toBe(1);
  });
});

describe('ManagementSignalsStream', () => {
  let brain: Brain;

  afterEach(() => {
    brain?.close();
  });

  it('computes review ratio correctly', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    // Create some placeholder entities for relation endpoints
    insertEntity(brain, { id: 'e-1', type: 'file', name: 'f1', namespace: 'proj-m', sourceActor: ACTOR });
    insertEntity(brain, { id: 'e-2', type: 'file', name: 'f2', namespace: 'proj-m', sourceActor: ACTOR });
    insertEntity(brain, { id: 'e-3', type: 'review', name: 'r1', namespace: 'proj-m', sourceActor: ACTOR });

    // 2 authored_by, 1 reviewed_by
    insertRelation(brain, {
      id: 'r-auth-1',
      type: 'authored_by',
      sourceId: 'e-1',
      targetId: 'e-2',
      namespace: 'proj-m',
      sourceActor: ACTOR,
      createdAt: '2025-01-10T00:00:00Z',
    });
    insertRelation(brain, {
      id: 'r-auth-2',
      type: 'authored_by',
      sourceId: 'e-2',
      targetId: 'e-3',
      namespace: 'proj-m',
      sourceActor: ACTOR,
      createdAt: '2025-01-05T00:00:00Z',
    });
    insertRelation(brain, {
      id: 'r-rev-1',
      type: 'reviewed_by',
      sourceId: 'e-3',
      targetId: 'e-1',
      namespace: 'proj-m',
      sourceActor: ACTOR,
      createdAt: '2025-01-12T00:00:00Z',
    });

    const stream = new ManagementSignalsStream();
    const result = await stream.run(ctx);

    expect(result.created).toBe(1);

    const facts = brain.entities
      .findByName('management-signals:proj-m', 'personal')
      .filter((e) => e.name === 'management-signals:proj-m');
    expect(facts.length).toBe(1);

    const props = facts[0].properties as Record<string, unknown>;
    expect(props.targetNamespace).toBe('proj-m');
    expect(props.reviewCount).toBe(1);
    expect(props.authoredCount).toBe(2);
    // ratio = 1 / (1 + 2) = 0.333...
    expect(props.reviewRatio).toBeCloseTo(1 / 3, 5);

    // 30-day trend should include all (all created within 30 days of NOW)
    const trend30d = props.trend30d as { reviews: number; authored: number; ratio: number };
    expect(trend30d.reviews).toBe(1);
    expect(trend30d.authored).toBe(2);
  });

  it('creates nothing when no matching relations exist', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    const stream = new ManagementSignalsStream();
    const result = await stream.run(ctx);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('upserts on second run (no duplicates)', async () => {
    brain = makeBrain();
    const ctx = makeCtx(brain);

    insertEntity(brain, { id: 'e-x', type: 'file', name: 'fx', namespace: 'ns', sourceActor: ACTOR });
    insertEntity(brain, { id: 'e-y', type: 'file', name: 'fy', namespace: 'ns', sourceActor: ACTOR });

    insertRelation(brain, {
      id: 'r-ab',
      type: 'authored_by',
      sourceId: 'e-x',
      targetId: 'e-y',
      namespace: 'ns',
      sourceActor: ACTOR,
    });

    const stream = new ManagementSignalsStream();

    const run1 = await stream.run(ctx);
    expect(run1.created).toBe(1);

    const run2 = await stream.run(ctx);
    expect(run2.created).toBe(0);
    expect(run2.updated).toBe(1);

    const facts = brain.entities
      .findByName('management-signals:ns', 'personal')
      .filter((e) => e.name === 'management-signals:ns');
    expect(facts.length).toBe(1);
  });
});
