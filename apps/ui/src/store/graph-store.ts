import { create } from 'zustand';
import type { Entity, Relation, EntityWithRelations } from '../lib/types.js';
import { api } from '../lib/api.js';

interface GraphState {
  entities: Map<string, Entity>;
  relations: Relation[];
  selectedEntityId: string | null;
  selectedEntity: EntityWithRelations | null;
  loading: boolean;
  error: string | null;

  fetchNeighbors: (entityId: string, depth?: number) => Promise<void>;
  fetchEntity: (id: string) => Promise<void>;
  selectEntity: (id: string | null) => void;
  loadRecent: (limit?: number) => Promise<void>;

  createEntity: (input: Parameters<typeof api.entities.create>[0]) => Promise<Entity>;
  updateEntity: (id: string, patch: Parameters<typeof api.entities.update>[1]) => Promise<void>;
  deleteEntity: (id: string) => Promise<void>;
  addObservation: (id: string, observation: string) => Promise<void>;
  removeObservation: (id: string, observation: string) => Promise<void>;

  createRelation: (input: Parameters<typeof api.relations.create>[0]) => Promise<Relation>;
  deleteRelation: (id: string) => Promise<void>;

  // WebSocket handlers
  handleEntityCreated: (entity: Entity) => void;
  handleEntityUpdated: (entity: Entity) => void;
  handleEntityDeleted: (id: string) => void;
  handleRelationCreated: (relation: Relation) => void;
  handleRelationDeleted: (id: string) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  entities: new Map(),
  relations: [],
  selectedEntityId: null,
  selectedEntity: null,
  loading: false,
  error: null,

  async fetchNeighbors(entityId, depth = 1) {
    set({ loading: true, error: null });
    try {
      const result = await api.entities.neighbors(entityId, { depth });
      const entities = new Map(get().entities);
      for (const entity of result.entities) {
        entities.set(entity.id, entity);
      }
      // Merge relations without duplicates
      const existingIds = new Set(get().relations.map((r) => r.id));
      const newRelations = result.relations.filter((r) => !existingIds.has(r.id));
      set({
        entities,
        relations: [...get().relations, ...newRelations],
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to fetch neighbors' });
    }
  },

  async fetchEntity(id) {
    set({ loading: true, error: null });
    try {
      const data = await api.entities.get(id);
      const entities = new Map(get().entities);
      entities.set(data.entity.id, data.entity);
      set({ entities, selectedEntity: data, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to fetch entity' });
    }
  },

  selectEntity(id) {
    set({ selectedEntityId: id, selectedEntity: null });
    if (id) {
      get().fetchEntity(id);
    }
  },

  async loadRecent(limit = 50) {
    set({ loading: true, error: null });
    try {
      const list = await api.entities.list({ limit });
      const entities = new Map<string, Entity>();
      for (const entity of list) {
        entities.set(entity.id, entity);
      }
      set({ entities, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load entities' });
    }
  },

  async createEntity(input) {
    const entity = await api.entities.create(input);
    const entities = new Map(get().entities);
    entities.set(entity.id, entity);
    set({ entities });
    return entity;
  },

  async updateEntity(id, patch) {
    const entity = await api.entities.update(id, patch);
    const entities = new Map(get().entities);
    entities.set(entity.id, entity);
    set({ entities });
    if (get().selectedEntityId === id) {
      get().fetchEntity(id);
    }
  },

  async deleteEntity(id) {
    await api.entities.delete(id);
    const entities = new Map(get().entities);
    entities.delete(id);
    const relations = get().relations.filter((r) => r.sourceId !== id && r.targetId !== id);
    set({
      entities,
      relations,
      selectedEntityId: get().selectedEntityId === id ? null : get().selectedEntityId,
      selectedEntity: get().selectedEntityId === id ? null : get().selectedEntity,
    });
  },

  async addObservation(id, observation) {
    const entity = await api.entities.addObservation(id, observation);
    const entities = new Map(get().entities);
    entities.set(entity.id, entity);
    set({ entities });
    if (get().selectedEntityId === id) {
      get().fetchEntity(id);
    }
  },

  async removeObservation(id, observation) {
    const entity = await api.entities.removeObservation(id, observation);
    const entities = new Map(get().entities);
    entities.set(entity.id, entity);
    set({ entities });
    if (get().selectedEntityId === id) {
      get().fetchEntity(id);
    }
  },

  async createRelation(input) {
    const relation = await api.relations.create(input);
    set({ relations: [...get().relations, relation] });
    return relation;
  },

  async deleteRelation(id) {
    await api.relations.delete(id);
    set({ relations: get().relations.filter((r) => r.id !== id) });
  },

  // WebSocket live update handlers
  handleEntityCreated(entity) {
    const entities = new Map(get().entities);
    entities.set(entity.id, entity);
    set({ entities });
  },

  handleEntityUpdated(entity) {
    const entities = new Map(get().entities);
    entities.set(entity.id, entity);
    set({ entities });
  },

  handleEntityDeleted(id) {
    const entities = new Map(get().entities);
    entities.delete(id);
    const relations = get().relations.filter((r) => r.sourceId !== id && r.targetId !== id);
    set({ entities, relations });
  },

  handleRelationCreated(relation) {
    const exists = get().relations.some((r) => r.id === relation.id);
    if (!exists) {
      set({ relations: [...get().relations, relation] });
    }
  },

  handleRelationDeleted(id) {
    set({ relations: get().relations.filter((r) => r.id !== id) });
  },
}));
