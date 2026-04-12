import type { DecayEngineConfig } from '@second-brain/types';
import { StorageDatabase, type DatabaseOptions } from './storage/index.js';
import { EntityManager } from './graph/entity-manager.js';
import { RelationManager } from './graph/relation-manager.js';
import { SearchEngine } from './search/search-engine.js';
import { BitemporalQueries } from './temporal/bitemporal-queries.js';
import { DecayEngine } from './temporal/decay-engine.js';
import { ContradictionDetector } from './temporal/contradiction-detector.js';

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

  constructor(options: BrainOptions) {
    this.storage = new StorageDatabase(options);
    this.entities = new EntityManager(this.storage.db);
    this.relations = new RelationManager(this.storage.db);
    this.search = new SearchEngine(this.storage);
    this.temporal = new BitemporalQueries(this.storage);
    this.decay = new DecayEngine(this.storage, options.decay);
    this.contradictions = new ContradictionDetector(this.storage, this.relations, this.entities);
  }

  close(): void {
    this.decay.stop();
    this.storage.close();
  }
}
