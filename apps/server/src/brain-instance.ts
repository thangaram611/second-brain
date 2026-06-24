import { join } from 'node:path';
import { homedir } from 'node:os';
import { Brain } from '@second-brain/core';
import { SyncManager } from '@second-brain/sync';
import {
  resolveLLMConfig,
  tryCreateLLMExtractor,
  tryCreateEmbeddingGenerator,
} from '@second-brain/ingestion';
import { ObservationService } from './services/observation-service.js';
import { PromotionService } from './services/promotion-service.js';
import { OwnershipService } from './services/ownership-service.js';
import { PersonalityExtractor } from './services/personality-extractor.js';
import { LanguageFingerprintStream } from './services/personality/language-fingerprint.js';
import { TechFamiliarityStream } from './services/personality/tech-familiarity.js';
import { ManagementSignalsStream } from './services/personality/management-signals.js';

let brainInstance: Brain | null = null;
let syncManagerInstance: SyncManager | null = null;
let observationInstance: ObservationService | null = null;
let promotionInstance: PromotionService | null = null;
let ownershipInstance: OwnershipService | null = null;
let personalityInstance: PersonalityExtractor | null = null;

function getBrain(): Brain {
  if (brainInstance) return brainInstance;

  const dbPath =
    process.env.BRAIN_DB_PATH ??
    join(homedir(), '.second-brain', 'personal.db');

  brainInstance = new Brain({ path: dbPath });

  // If embeddings already exist on disk, wire the vector search channel now so
  // queries use it from the first request — not only after an in-process
  // /api/rebuild-embeddings. Best-effort: degrade to full-text if no embedder.
  try {
    if (brainInstance.enableVectorSearchFromStore() !== null) {
      const generator = tryCreateEmbeddingGenerator(resolveLLMConfig(), {
        logger: { warn: (m) => console.warn('[second-brain] vector channel disabled:', m) },
      });
      if (generator) {
        brainInstance.attachVectorChannel((q) => generator.generateQuery(q));
      }
    }
  } catch (err) {
    console.warn(
      '[second-brain] vector channel init skipped:',
      err instanceof Error ? err.message : err,
    );
  }

  return brainInstance;
}

export function closeBrain(): void {
  if (brainInstance) {
    brainInstance.close();
    brainInstance = null;
    observationInstance = null;
    promotionInstance = null;
    ownershipInstance = null;
    personalityInstance = null;
  }
}

function getSyncManager(): SyncManager {
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

function getPromotionService(): PromotionService {
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

function getObservationService(): ObservationService {
  if (observationInstance) return observationInstance;
  const brain = getBrain();
  const promotion = getPromotionService();
  observationInstance = new ObservationService(brain, promotion, {
    retentionDays: Number(process.env.SESSION_RETENTION_DAYS ?? 30),
  });
  return observationInstance;
}

function getOwnershipService(): OwnershipService {
  if (ownershipInstance) return ownershipInstance;
  const brain = getBrain();
  ownershipInstance = new OwnershipService(brain);
  return ownershipInstance;
}

function getPersonalityExtractor(): PersonalityExtractor | null {
  if (personalityInstance !== null) return personalityInstance;

  const enabled = process.env.PERSONALITY_ENABLED !== 'false';
  if (!enabled) return null;

  const brain = getBrain();

  personalityInstance = new PersonalityExtractor(brain);

  // Register all personality streams
  personalityInstance.registerStream(new LanguageFingerprintStream());
  personalityInstance.registerStream(new TechFamiliarityStream());
  personalityInstance.registerStream(new ManagementSignalsStream());

  return personalityInstance;
}

// --- Unified service container -------------------------------------------

export interface Services {
  brain: Brain;
  syncManager: SyncManager;
  observations: ObservationService;
  promotion: PromotionService;
  ownership: OwnershipService;
  personality: PersonalityExtractor | null;
}

/**
 * Returns a typed object with every singleton service.
 * Lazily initialises each service on first call (same instances as the
 * individual getters).
 */
export function getServices(): Services {
  return {
    brain: getBrain(),
    syncManager: getSyncManager(),
    observations: getObservationService(),
    promotion: getPromotionService(),
    ownership: getOwnershipService(),
    personality: getPersonalityExtractor(),
  };
}
