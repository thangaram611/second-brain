import express from 'express';
import type { Brain } from '@second-brain/core';
import type { SyncManager } from '@second-brain/sync';
import { cors } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { registerRoutes } from './routes/index.js';

export function createApp(brain: Brain, syncManager?: SyncManager): express.Express {
  const app = express();

  app.use(cors);
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  registerRoutes(app, brain, syncManager);

  app.use(errorHandler);

  return app;
}
