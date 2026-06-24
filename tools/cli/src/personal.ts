import type { Brain, PersonalBundle } from '@second-brain/core';
import {
  ENTITY_TYPES,
  ENTITY_SOURCE_TYPES,
  RELATION_TYPES,
} from '@second-brain/types';
import * as fs from 'node:fs';
import { z } from 'zod';
import { isRecord } from './adapters/shared/json-file.js';

const EntitySourceSchema = z.object({
  type: z.enum(ENTITY_SOURCE_TYPES),
  ref: z.string().optional(),
  actor: z.string().optional(),
});

const EntitySchema = z.object({
  id: z.string(),
  type: z.enum(ENTITY_TYPES),
  name: z.string(),
  namespace: z.string(),
  observations: z.array(z.string()),
  properties: z.record(z.string(), z.unknown()),
  confidence: z.number(),
  eventTime: z.string(),
  ingestTime: z.string(),
  lastAccessedAt: z.string(),
  accessCount: z.number(),
  source: EntitySourceSchema,
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RelationSchema = z.object({
  id: z.string(),
  type: z.enum(RELATION_TYPES),
  sourceId: z.string(),
  targetId: z.string(),
  namespace: z.string(),
  properties: z.record(z.string(), z.unknown()),
  confidence: z.number(),
  weight: z.number(),
  bidirectional: z.boolean(),
  source: EntitySourceSchema,
  eventTime: z.string(),
  ingestTime: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Annotated as ZodType<PersonalBundle> so this schema fails to compile if the
// canonical bundle type in @second-brain/core ever drifts from these fields.
const PersonalBundleSchema: z.ZodType<PersonalBundle> = z.object({
  version: z.literal('1.0'),
  exportedAt: z.string(),
  entities: z.array(EntitySchema),
  relations: z.array(RelationSchema),
  manifest: z.object({
    danglingEntityIds: z.array(z.string()),
    sourceHostname: z.string(),
    schemaVersion: z.number(),
  }),
  sha256: z.string(),
});

// Each personality-stats query returns rows of a fixed shape; validate at the
// SQLite boundary so malformed rows fail loudly rather than silently.
const SourceTypeCountSchema = z.array(
  z.object({ source_type: z.string(), count: z.number() }),
);
const SourceRefCountSchema = z.array(
  // source_ref is a nullable column — a personality entity written without a
  // ref groups into a NULL bucket here, so model it nullable to match the DB.
  z.object({ source_ref: z.string().nullable(), count: z.number() }),
);
const PersonalityAuditRowSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
    confidence: z.number(),
    streamName: z.string().nullable(),
    derivedFromIds: z.string().nullable(),
  }),
);

export async function runPersonalExport(
  brain: Brain,
  options: { out: string; encrypt?: boolean; json?: boolean },
): Promise<void> {
  const { exportPersonal } = await import('@second-brain/core');
  const bundle = exportPersonal(brain);
  const jsonStr = JSON.stringify(bundle, null, 2);

  if (options.encrypt) {
    const { password } = await import('@clack/prompts');
    const pass1 = await password({ message: 'Passphrase:' });
    if (typeof pass1 === 'symbol') {
      console.error('Cancelled.');
      process.exit(1);
    }
    const pass2 = await password({ message: 'Confirm passphrase:' });
    if (typeof pass2 === 'symbol') {
      console.error('Cancelled.');
      process.exit(1);
    }
    if (pass1 !== pass2) {
      console.error('Passphrases do not match.');
      process.exit(1);
    }

    const { encryptBundle } = await import('./personal-crypto.js');
    const encrypted = await encryptBundle(jsonStr, pass1);
    fs.writeFileSync(options.out, encrypted);
  } else {
    fs.writeFileSync(options.out, jsonStr);
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        entities: bundle.entities.length,
        relations: bundle.relations.length,
        danglingEdges: bundle.manifest.danglingEntityIds.length,
        file: options.out,
        encrypted: !!options.encrypt,
      }),
    );
  } else {
    console.log(
      `Exported ${bundle.entities.length} entities, ${bundle.relations.length} relations`,
    );
    console.log(
      `Dangling cross-namespace edges: ${bundle.manifest.danglingEntityIds.length}`,
    );
    console.log(`Written to: ${options.out}`);
    if (options.encrypt) console.log('(encrypted)');
  }
}

export async function runPersonalImport(
  brain: Brain,
  options: { file: string; reattach?: boolean; json?: boolean },
): Promise<void> {
  const raw = fs.readFileSync(options.file);

  let jsonStr: string;
  // Check SBP1 magic header inline to avoid importing crypto module for plain bundles
  const isEncrypted =
    raw.length >= 4 && raw.subarray(0, 4).toString() === 'SBP1';
  if (isEncrypted) {
    const { password } = await import('@clack/prompts');
    const pass = await password({ message: 'Passphrase:' });
    if (typeof pass === 'symbol') {
      console.error('Cancelled.');
      process.exit(1);
    }
    const { decryptBundle } = await import('./personal-crypto.js');
    try {
      jsonStr = await decryptBundle(raw, pass);
    } catch {
      console.error('Decryption failed. Wrong passphrase?');
      process.exit(1);
    }
  } else {
    jsonStr = raw.toString('utf-8');
  }

  const rawBundle: unknown = JSON.parse(jsonStr);

  // Surface a friendly, version-specific message before full structural
  // validation so operators with an old/foreign bundle get an actionable hint.
  const version = isRecord(rawBundle) ? rawBundle.version : undefined;
  if (version !== '1.0') {
    console.error(`Unsupported bundle version: ${String(version)}`);
    process.exit(1);
  }

  const parsedBundle = PersonalBundleSchema.safeParse(rawBundle);
  if (!parsedBundle.success) {
    console.error(`Invalid bundle: ${parsedBundle.error.message}`);
    process.exit(1);
  }
  const bundle = parsedBundle.data;

  const { importPersonal } = await import('@second-brain/core');
  const result = importPersonal(brain, bundle, { reattach: options.reattach });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `Imported ${result.entitiesImported} entities, ${result.relationsImported} relations`,
    );
    if (result.droppedDanglingEdges > 0) {
      console.log(
        `Dropped ${result.droppedDanglingEdges} dangling edges (use --reattach to keep)`,
      );
    }
    if (result.conflicts.length > 0) {
      console.log(`Conflicts: ${result.conflicts.length}`);
    }
  }
}

export async function runPersonalStats(
  brain: Brain,
  options: { audit?: boolean; json?: boolean },
): Promise<void> {
  const stats = brain.search.getStats('personal');

  const sourceTypes = SourceTypeCountSchema.parse(
    brain.storage.sqlite
      .prepare(
        `SELECT source_type, COUNT(*) as count FROM entities WHERE namespace = 'personal' GROUP BY source_type`,
      )
      .all(),
  );

  const streams = SourceRefCountSchema.parse(
    brain.storage.sqlite
      .prepare(
        `SELECT source_ref, COUNT(*) as count FROM entities WHERE namespace = 'personal' AND source_type = 'personality' GROUP BY source_ref`,
      )
      .all(),
  );

  if (options.json) {
    console.log(JSON.stringify({ stats, sourceTypes, streams }));
    return;
  }

  console.log('Personal namespace stats:');
  console.log(`  Entities: ${stats.totalEntities}`);
  console.log(`  Relations: ${stats.totalRelations}`);

  if (sourceTypes.length > 0) {
    console.log('\nBy source type:');
    for (const s of sourceTypes) {
      console.log(`  ${s.source_type}: ${s.count}`);
    }
  }

  if (streams.length > 0) {
    console.log('\nBy personality stream:');
    for (const s of streams) {
      console.log(`  ${s.source_ref ?? '(no source ref)'}: ${s.count}`);
    }
  }

  if (options.audit) {
    const entities = PersonalityAuditRowSchema.parse(
      brain.storage.sqlite
        .prepare(
          `
        SELECT e.name, e.type, e.confidence, e.source_ref as streamName,
          group_concat(r.target_id) as derivedFromIds
        FROM entities e
        LEFT JOIN relations r ON r.source_id = e.id AND r.type = 'derived_from'
        WHERE e.namespace = 'personal' AND e.source_type = 'personality'
        GROUP BY e.id
        ORDER BY e.source_ref, e.name
      `,
        )
        .all(),
    );

    console.log(`\nAudit (${entities.length} personality entities):`);
    for (const e of entities) {
      const derived = e.derivedFromIds
        ? e.derivedFromIds.split(',').length
        : 0;
      console.log(
        `  [${e.streamName ?? 'unknown'}] ${e.name} (${e.type}, conf=${e.confidence.toFixed(2)}, derived_from=${derived})`,
      );
    }
  }
}
