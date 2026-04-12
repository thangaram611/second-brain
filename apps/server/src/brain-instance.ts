import { join } from 'node:path';
import { homedir } from 'node:os';
import { Brain } from '@second-brain/core';

let brainInstance: Brain | null = null;

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
