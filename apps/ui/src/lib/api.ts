import type {
  Entity,
  EntityWithRelations,
  Relation,
  SearchResult,
  GraphStats,
  NeighborResult,
  TimelineEntry,
  Contradiction,
  StaleEntity,
  SyncStatus,
  PeerInfo,
} from './types.js';

import type { OwnershipNode } from '../store/ownership-store.js';
import { useAuthStore } from '../store/auth-store.js';

export interface ParallelWorkConflict {
  entityId: string;
  entityName: string;
  entityType: string;
  namespace: string;
  actors: string[];
  branches: string[];
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') qs.set(key, String(value));
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isMutating(method: string | undefined): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/**
 * Hard-redirect to /login. Uses HashRouter convention to match main.tsx.
 * Exported (via auth-store) so route-mock layers in tests can intercept.
 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash === '#/login' || window.location.pathname === '/login') return;
  window.location.hash = '#/login';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Build headers — start from any caller-supplied headers and layer in
  // Content-Type + the CSRF token (only on mutating verbs, only if we have one).
  const incomingHeaders = new Headers(init?.headers);
  if (!incomingHeaders.has('Content-Type')) {
    incomingHeaders.set('Content-Type', 'application/json');
  }
  if (isMutating(init?.method)) {
    const csrf = useAuthStore.getState().csrfToken;
    if (csrf) incomingHeaders.set('X-CSRF-Token', csrf);
  }

  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: incomingHeaders,
  });

  if (res.status === 401) {
    // In pat-mode the session expired or never existed — bounce to /login.
    // In open or unknown mode, surface the error like any other (the server
    // shouldn't 401 in open mode, but if it does we don't want to loop).
    const mode = useAuthStore.getState().mode;
    if (mode === 'pat') {
      redirectToLogin();
    }
  }

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
      return request<Entity[]>(`/entities${buildQuery({
        namespace: params?.namespace,
        type: params?.type,
        limit: params?.limit,
        offset: params?.offset,
      })}`);
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
      return request<NeighborResult>(`/entities/${id}/neighbors${buildQuery({
        depth: opts?.depth,
        relationTypes: opts?.relationTypes,
      })}`);
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
    return request<SearchResult[]>(`/search${buildQuery({
      q: params.q,
      types: params.types,
      namespace: params.namespace,
      limit: params.limit,
      minConfidence: params.minConfidence,
    })}`);
  },

  stats(namespace?: string) {
    return request<GraphStats>(`/stats${buildQuery({ namespace })}`);
  },

  // --- Temporal API (Phase 5) ---

  timeline(params: { from: string; to: string; types?: string; namespace?: string; limit?: number }) {
    return request<TimelineEntry[]>(`/timeline${buildQuery({
      from: params.from,
      to: params.to,
      types: params.types,
      namespace: params.namespace,
      limit: params.limit,
    })}`);
  },

  contradictions: {
    list() {
      return request<Contradiction[]>(`/contradictions`);
    },

    resolve(relationId: string, winnerId: string) {
      return request<{ resolved: boolean; winnerId: string; loserId: string }>(
        `/contradictions/${relationId}/resolve`,
        { method: 'POST', body: JSON.stringify({ winnerId }) },
      );
    },

    dismiss(relationId: string) {
      return request<void>(`/contradictions/${relationId}`, { method: 'DELETE' });
    },
  },

  decisions(params?: { namespace?: string; limit?: number; offset?: number; sort?: string }) {
    return request<Entity[]>(`/decisions${buildQuery({
      namespace: params?.namespace,
      limit: params?.limit,
      offset: params?.offset,
      sort: params?.sort,
    })}`);
  },

  stale(params?: { threshold?: number; namespace?: string; types?: string; limit?: number }) {
    return request<StaleEntity[]>(`/stale${buildQuery({
      threshold: params?.threshold,
      namespace: params?.namespace,
      types: params?.types,
      limit: params?.limit,
    })}`);
  },

  // --- Sync API (Phase 6) ---

  sync: {
    status() {
      return request<SyncStatus[]>('/sync/status');
    },

    statusFor(namespace: string) {
      return request<SyncStatus>(`/sync/status/${encodeURIComponent(namespace)}`);
    },

    join(config: { namespace: string; relayUrl: string; token: string }) {
      return request<SyncStatus>('/sync/join', {
        method: 'POST',
        body: JSON.stringify(config),
      });
    },

    leave(namespace: string) {
      return request<{ left: string }>('/sync/leave', {
        method: 'POST',
        body: JSON.stringify({ namespace }),
      });
    },

    peers(namespace: string) {
      return request<PeerInfo[]>(`/sync/peers/${encodeURIComponent(namespace)}`);
    },
  },

  parallelWork: {
    list(params?: { branch?: string; namespace?: string; limit?: number }) {
      return request<{ conflicts: Array<{ entityId: string; entityName: string; entityType: string; namespace: string; actors: string[]; branches: string[] }> }>(`/query/parallel-work${buildQuery({
        branch: params?.branch,
        namespace: params?.namespace,
        limit: params?.limit,
      })}`);
    },
  },

  // --- Admin / Phase 7 ---

  query(params: { question: string; namespace?: string; limit?: number }) {
    return request<{
      question: string;
      interpreted: string | null;
      results: SearchResult[];
    }>('/query', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  import(params: {
    content: string;
    format: 'json' | 'json-ld';
    strategy?: 'replace' | 'merge' | 'upsert';
    namespace?: string;
  }) {
    return request<{
      entitiesImported: number;
      relationsImported: number;
      conflicts: Array<{ entityType: string; entityName: string; reason: string }>;
    }>('/import', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  embeddingStatus() {
    return request<{
      vectorEnabled: boolean;
      byNamespace: Array<{
        namespace: string;
        total: number;
        embedded: number;
        coverage: number;
      }>;
    }>('/embeddings/status');
  },

  rebuildEmbeddings(params?: { namespace?: string; batchSize?: number; dimensions?: number }) {
    return request<{
      ok: boolean;
      model: string;
      embedded: number;
      skipped: number;
      errors: number;
      durationMs: number;
    }>('/rebuild-embeddings', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    });
  },

  ownership: {
    tree(path?: string, depth?: number) {
      return request<OwnershipNode>(`/query/ownership-tree${buildQuery({ path, depth })}`);
    },
  },

  auth: {
    rotatePat() {
      return request<{ pat: string; tokenId: string; expiresAt: string | null }>('/auth/rotate', {
        method: 'POST',
      });
    },
  },

};
