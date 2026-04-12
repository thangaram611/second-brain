import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: 'Validation error',
      details: err.issues,
    });
    return;
  }

  const message =
    err instanceof Error ? err.message : 'Internal server error';
  console.error('[server]', err);
  res.status(500).json({ error: message });
}
