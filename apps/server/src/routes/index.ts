import type { Express } from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import { entityRoutes } from './entities.js';
import { relationRoutes } from './relations.js';
import { searchRoutes } from './search.js';
import { syncRoutes } from './sync.js';
import { temporalRoutes } from './temporal.js';
import { adminRoutes } from './admin.js';
import { observeRoutes, type ObserveRouteOptions } from './observe.js';
import type { ObservationService } from '../services/observation-service.js';

export interface RegisterRoutesOptions {
  syncManager?: SyncManager;
  observations?: ObservationService;
  observeOptions?: ObserveRouteOptions;
}

export function registerRoutes(
  app: Express,
  brain: Brain,
  options: RegisterRoutesOptions = {},
): void {
  const { syncManager, observations, observeOptions } = options;
  app.use(entityRoutes(brain, syncManager));
  app.use(relationRoutes(brain, syncManager));
  app.use(searchRoutes(brain));
  app.use(temporalRoutes(brain));
  app.use(adminRoutes(brain));
  if (syncManager) {
    app.use(syncRoutes(syncManager));
  }
  if (observations) {
    app.use(observeRoutes(observations, observeOptions));
  }
}
