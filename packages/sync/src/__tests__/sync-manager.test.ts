import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '@second-brain/core';
import type { CreateEntityInput } from '@second-brain/types';
import { SyncManager } from '../sync-manager.js';

let brain: Brain;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
});

afterEach(() => {
  brain.close();
});

function makeEntityInput(name: string, namespace = 'team-a'): CreateEntityInput {
  return {
    type: 'concept',
    name,
    namespace,
    source: { type: 'manual' },
  };
}

describe('SyncManager', () => {
  it('rejects joining the personal namespace', async () => {
    const manager = new SyncManager(brain.entities, brain.relations);

    await expect(
      manager.join({
        namespace: 'personal',
        relayUrl: 'ws://localhost:8080',
        token: 'test-token',
        enabled: true,
      }),
    ).rejects.toThrow('Cannot sync the "personal" namespace');

    manager.destroy();
  });

  it('getStatus returns null for unknown namespace', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    expect(manager.getStatus('nonexistent')).toBeNull();
    manager.destroy();
  });

  it('getAllStatuses returns empty array initially', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    expect(manager.getAllStatuses()).toEqual([]);
    manager.destroy();
  });

  it('isSynced returns false for unknown namespace', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    expect(manager.isSynced('nonexistent')).toBe(false);
    manager.destroy();
  });

  it('getPeers returns empty for unknown namespace', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    expect(manager.getPeers('nonexistent')).toEqual([]);
    manager.destroy();
  });

  it('onLocalEntityChange is a no-op for unjoined namespaces', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    const entity = brain.entities.create(makeEntityInput('Test'));

    // Should not throw
    expect(() => manager.onLocalEntityChange(entity)).not.toThrow();
    manager.destroy();
  });

  it('onLocalEntityDelete is a no-op for unjoined namespaces', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    expect(() => manager.onLocalEntityDelete('some-id', 'team-a')).not.toThrow();
    manager.destroy();
  });

  it('destroy cleans up without errors', () => {
    const manager = new SyncManager(brain.entities, brain.relations);
    expect(() => manager.destroy()).not.toThrow();
  });
});
