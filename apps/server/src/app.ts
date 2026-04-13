import express from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import { cors } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { registerRoutes, type RegisterRoutesOptions } from './routes/index.js';

export interface CreateAppOptions extends RegisterRoutesOptions {}

export function createApp(
  brain: Brain,
  syncManagerOrOptions?: SyncManager | CreateAppOptions,
): express.Express {
  const app = express();

  app.use(cors);
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  const options: CreateAppOptions = isSyncManager(syncManagerOrOptions)
    ? { syncManager: syncManagerOrOptions }
    : syncManagerOrOptions ?? {};

  registerRoutes(app, brain, options);

  app.use(errorHandler);

  return app;
}

function isSyncManager(value: unknown): value is SyncManager {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { isSynced?: unknown }).isSynced === 'function' &&
    typeof (value as { onLocalEntityChange?: unknown }).onLocalEntityChange === 'function'
  );
}
