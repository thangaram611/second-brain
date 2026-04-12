import type { Brain } from '@second-brain/core';
import type {
  Collector,
  PipelineConfig,
  PipelineRunSummary,
  ExtractionResult,
  PendingRelation,
  ProgressCallback,
} from './types.js';
import { resolveRelations } from './resolver.js';

export class PipelineRunner {
  private collectors: Collector[] = [];

  constructor(private brain: Brain) {}

  register(collector: Collector): this {
    this.collectors.push(collector);
    return this;
  }

  async run(config: PipelineConfig): Promise<PipelineRunSummary> {
    const start = Date.now();
    const errors: PipelineRunSummary['errors'] = [];
    const allEntities: ExtractionResult['entities'] = [];
    const allRelations: PendingRelation[] = [];
    const onProgress = config.onProgress;

    // Phase 1: Collect from all registered collectors
    for (let i = 0; i < this.collectors.length; i++) {
      const collector = this.collectors[i];
      notify(onProgress, {
        stage: 'collecting',
        collector: collector.name,
        current: i + 1,
        total: this.collectors.length,
        message: `Collecting from ${collector.name}...`,
      });

      try {
        const result = await collector.collect(config);
        allEntities.push(...result.entities);
        allRelations.push(...result.relations);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ collector: collector.name, message });
      }
    }

    // Phase 2: Batch-upsert all entities
    notify(onProgress, {
      stage: 'storing',
      current: 1,
      total: 2,
      message: `Upserting ${allEntities.length} entities...`,
    });

    const upsertedEntities = allEntities.length > 0
      ? this.brain.entities.batchUpsert(allEntities)
      : [];

    // Phase 3: Resolve name-based relations to ID-based
    notify(onProgress, {
      stage: 'resolving',
      current: 1,
      total: 1,
      message: `Resolving ${allRelations.length} relations...`,
    });

    const { resolved, skipped } = resolveRelations(
      this.brain,
      allRelations,
      config.namespace,
    );

    // Phase 4: Batch-upsert all resolved relations
    notify(onProgress, {
      stage: 'storing',
      current: 2,
      total: 2,
      message: `Upserting ${resolved.length} relations...`,
    });

    const upsertedRelations = resolved.length > 0
      ? this.brain.relations.batchUpsert(resolved)
      : [];

    const durationMs = Date.now() - start;

    notify(onProgress, {
      stage: 'done',
      current: 1,
      total: 1,
      message: `Done in ${durationMs}ms: ${upsertedEntities.length} entities, ${upsertedRelations.length} relations`,
    });

    return {
      entitiesCreated: upsertedEntities.length,
      relationsCreated: upsertedRelations.length,
      relationsSkipped: skipped,
      errors,
      durationMs,
    };
  }
}

function notify(cb: ProgressCallback | undefined, progress: Parameters<ProgressCallback>[0]): void {
  if (cb) cb(progress);
}
