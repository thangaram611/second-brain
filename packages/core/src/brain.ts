import { StorageDatabase, type DatabaseOptions } from './storage/index.js';
import { EntityManager } from './graph/entity-manager.js';
import { RelationManager } from './graph/relation-manager.js';
import { SearchEngine } from './search/search-engine.js';

export interface BrainOptions extends DatabaseOptions {}

/**
 * Main entry point — wraps storage, graph, and search into a single API.
 */
export class Brain {
  readonly storage: StorageDatabase;
  readonly entities: EntityManager;
  readonly relations: RelationManager;
  readonly search: SearchEngine;

  constructor(options: BrainOptions) {
    this.storage = new StorageDatabase(options);
    this.entities = new EntityManager(this.storage.db);
    this.relations = new RelationManager(this.storage.db);
    this.search = new SearchEngine(this.storage);
  }

  close(): void {
    this.storage.close();
  }
}
