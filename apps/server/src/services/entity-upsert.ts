import type { Brain } from '@second-brain/core';
import type { Entity, EntitySource } from '@second-brain/types';

/**
 * Upsert a file entity by path within a namespace. Shared by
 * ObservationService (hook/file-change paths) and MrEventService (MR touches)
 * so neither reaches into the other's internals.
 */
export function upsertFileEntity(brain: Brain, ns: string, filePath: string, actor?: string): Entity {
  const matches = brain.entities.findByName(filePath, ns);
  const existing = matches.find((e) => e.type === 'file' && e.name === filePath);
  if (existing) return existing;
  const source: EntitySource = actor
    ? { type: 'conversation', actor }
    : { type: 'conversation' };
  return brain.entities.create({
    type: 'file',
    name: filePath,
    namespace: ns,
    observations: [],
    properties: { path: filePath },
    tags: ['file'],
    source,
  });
}
