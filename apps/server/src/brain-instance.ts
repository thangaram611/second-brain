import { join } from 'node:path';
import { homedir } from 'node:os';
import { Brain } from '@second-brain/core';
import { SyncManager } from '@second-brain/sync';
import { resolveLLMConfig, tryCreateLLMExtractor } from '@second-brain/ingestion';
import { ObservationService } from './services/observation-service.js';
import { PromotionService } from './services/promotion-service.js';

let brainInstance: Brain | null = null;
let syncManagerInstance: SyncManager | null = null;
let observationInstance: ObservationService | null = null;
let promotionInstance: PromotionService | null = null;

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
    observationInstance = null;
    promotionInstance = null;
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

export function getPromotionService(): PromotionService {
  if (promotionInstance) return promotionInstance;
  const brain = getBrain();
  const extractor = tryCreateLLMExtractor(resolveLLMConfig(), {
    logger: {
      warn: (m) => console.warn('[second-brain] promotion extractor disabled:', m),
    },
  });
  promotionInstance = new PromotionService(brain, extractor, {
    confidenceMin: Number(process.env.BRAIN_PROMOTION_CONFIDENCE_MIN ?? 0.6),
  });
  return promotionInstance;
}

export function getObservationService(): ObservationService {
  if (observationInstance) return observationInstance;
  const brain = getBrain();
  const promotion = getPromotionService();
  observationInstance = new ObservationService(brain, promotion, {
    retentionDays: Number(process.env.SESSION_RETENTION_DAYS ?? 30),
  });
  return observationInstance;
}
