import type { Express } from 'express';
import type { Brain } from '@second-brain/core';
import { entityRoutes } from './entities.js';
import { relationRoutes } from './relations.js';
import { searchRoutes } from './search.js';
import { temporalRoutes } from './temporal.js';

export function registerRoutes(app: Express, brain: Brain): void {
  app.use(entityRoutes(brain));
  app.use(relationRoutes(brain));
  app.use(searchRoutes(brain));
  app.use(temporalRoutes(brain));
}
