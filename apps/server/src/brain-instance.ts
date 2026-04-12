import { join } from 'node:path';
import { homedir } from 'node:os';
import { Brain } from '@second-brain/core';
import { SyncManager } from '@second-brain/sync';

let brainInstance: Brain | null = null;
let syncManagerInstance: SyncManager | null = null;

export function getBrain(): Brain {
  if (brainInstance) return brainInstance;

  const dbPath =
    process.env.BRAIN_DB_PATH ??
    join(homedir(), '.second-brain', 'personal.db');

  brainInstance = new Brain({ path: dbPath });
  return brainInstance;
}

export function closeBrain(): void {
  if (brainInstance) {
    brainInstance.close();
    brainInstance = null;
  }
}

export function getSyncManager(): SyncManager {
  if (syncManagerInstance) return syncManagerInstance;
  const brain = getBrain();
  syncManagerInstance = new SyncManager(brain.entities, brain.relations);
  return syncManagerInstance;
}

export function closeSyncManager(): void {
  if (syncManagerInstance) {
    syncManagerInstance.destroy();
    syncManagerInstance = null;
  }
}
