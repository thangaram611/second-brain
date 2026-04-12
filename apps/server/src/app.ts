import express from 'express';
import type { Brain } from '@second-brain/core';
import { cors } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { registerRoutes } from './routes/index.js';

export function createApp(brain: Brain): express.Express {
  const app = express();

  app.use(cors);
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  registerRoutes(app, brain);

  app.use(errorHandler);

  return app;
}
