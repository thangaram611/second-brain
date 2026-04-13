import type { DecayEngineConfig } from '@second-brain/types';
import { StorageDatabase, type DatabaseOptions } from './storage/index.js';
import { EntityManager } from './graph/entity-manager.js';
import { RelationManager } from './graph/relation-manager.js';
import { SearchEngine } from './search/search-engine.js';
import { BitemporalQueries } from './temporal/bitemporal-queries.js';
import { DecayEngine } from './temporal/decay-engine.js';
import { ContradictionDetector } from './temporal/contradiction-detector.js';
import { EmbeddingStore } from './embeddings/index.js';

export interface BrainOptions extends DatabaseOptions {
  decay?: DecayEngineConfig;
}

/**
 * Main entry point — wraps storage, graph, search, and temporal into a single API.
 */
export class Brain {
  readonly storage: StorageDatabase;
  readonly entities: EntityManager;
  readonly relations: RelationManager;
  readonly search: SearchEngine;
  readonly temporal: BitemporalQueries;
  readonly decay: DecayEngine;
  readonly contradictions: ContradictionDetector;
  /**
   * Vector embedding store. Non-null only when `vectorDimensions` was set
   * in BrainOptions or `enableVectorSearch()` was called on storage.
   */
  readonly embeddings: EmbeddingStore | null;

  constructor(options: BrainOptions) {
    this.storage = new StorageDatabase(options);
    this.entities = new EntityManager(this.storage.db);
    this.relations = new RelationManager(this.storage.db);
    this.search = new SearchEngine(this.storage);
    this.temporal = new BitemporalQueries(this.storage);
    this.decay = new DecayEngine(this.storage, options.decay);
    this.contradictions = new ContradictionDetector(this.storage, this.relations, this.entities);
    this.embeddings = this.storage.vectorDimensions !== null ? new EmbeddingStore(this.storage) : null;
  }

  /**
   * Enable vector search after construction (e.g. when the LLM config is
   * loaded later). Idempotent for the same dimension.
   */
  enableVectorSearch(dimensions: number): EmbeddingStore {
    this.storage.enableVectorSearch(dimensions);
    if (this.embeddings === null) {
      // EmbeddingStore is readonly but we set it in the constructor based on
      // storage state — once enabled, replace via Object.defineProperty so the
      // public type stays accurate without a non-readonly field.
      Object.defineProperty(this, 'embeddings', {
        value: new EmbeddingStore(this.storage),
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    if (this.embeddings === null) throw new Error('enableVectorSearch failed to initialize EmbeddingStore');
    return this.embeddings;
  }

  close(): void {
    this.decay.stop();
    this.storage.close();
  }
}
