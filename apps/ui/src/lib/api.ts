import type {
  Entity,
  EntityWithRelations,
  Relation,
  SearchResult,
  GraphStats,
  NeighborResult,
} from './types.js';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  entities: {
    list(params?: { namespace?: string; type?: string; limit?: number; offset?: number }) {
      const qs = new URLSearchParams();
      if (params?.namespace) qs.set('namespace', params.namespace);
      if (params?.type) qs.set('type', params.type);
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.offset) qs.set('offset', String(params.offset));
      const q = qs.toString();
      return request<Entity[]>(`/entities${q ? `?${q}` : ''}`);
    },

    get(id: string) {
      return request<EntityWithRelations>(`/entities/${id}`);
    },

    create(input: {
      type: string;
      name: string;
      observations?: string[];
      tags?: string[];
      namespace?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
    }) {
      return request<Entity>('/entities', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    update(id: string, patch: {
      name?: string;
      observations?: string[];
      tags?: string[];
      properties?: Record<string, unknown>;
      confidence?: number;
    }) {
      return request<Entity>(`/entities/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    delete(id: string) {
      return request<void>(`/entities/${id}`, { method: 'DELETE' });
    },

    addObservation(id: string, observation: string) {
      return request<Entity>(`/entities/${id}/observations`, {
        method: 'POST',
        body: JSON.stringify({ observation }),
      });
    },

    removeObservation(id: string, observation: string) {
      return request<Entity>(`/entities/${id}/observations`, {
        method: 'DELETE',
        body: JSON.stringify({ observation }),
      });
    },

    neighbors(id: string, opts?: { depth?: number; relationTypes?: string }) {
      const qs = new URLSearchParams();
      if (opts?.depth) qs.set('depth', String(opts.depth));
      if (opts?.relationTypes) qs.set('relationTypes', opts.relationTypes);
      const q = qs.toString();
      return request<NeighborResult>(`/entities/${id}/neighbors${q ? `?${q}` : ''}`);
    },
  },

  relations: {
    create(input: {
      type: string;
      sourceId: string;
      targetId: string;
      namespace?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
      weight?: number;
      bidirectional?: boolean;
    }) {
      return request<Relation>('/relations', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    delete(id: string) {
      return request<void>(`/relations/${id}`, { method: 'DELETE' });
    },
  },

  search(params: { q: string; types?: string; namespace?: string; limit?: number; minConfidence?: number }) {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    if (params.types) qs.set('types', params.types);
    if (params.namespace) qs.set('namespace', params.namespace);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.minConfidence) qs.set('minConfidence', String(params.minConfidence));
    return request<SearchResult[]>(`/search?${qs.toString()}`);
  },

  stats(namespace?: string) {
    const qs = namespace ? `?namespace=${namespace}` : '';
    return request<GraphStats>(`/stats${qs}`);
  },
};
