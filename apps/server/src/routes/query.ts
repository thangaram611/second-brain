import fs from 'node:fs';
import nodePath from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { Brain } from '@second-brain/core';
import type { OwnershipService, OwnershipScore } from '../services/ownership-service.js';
import { resolveScopedNamespace } from '../middleware/auth.js';
import type { UsersService } from '../services/users.js';

export interface QueryRouteOptions {
  bearerToken?: string;
  brain?: Brain;
  users?: UsersService | null;
}

interface OwnershipNode {
  path: string;
  name: string;
  isDir: boolean;
  owners?: Array<{ actor: string; score: number }>;
  children?: OwnershipNode[];
}

async function buildOwnershipTree(
  ownership: OwnershipService,
  absPath: string,
  relPath: string,
  depth: number,
  limit: number,
): Promise<OwnershipNode> {
  const stat = fs.statSync(absPath, { throwIfNoEntry: false });
  if (!stat) {
    throw Object.assign(new Error(`Path not found: ${relPath}`), { code: 'ENOENT' });
  }

  const name = nodePath.basename(relPath) || relPath;

  if (!stat.isDirectory()) {
    let owners: Array<{ actor: string; score: number }> = [];
    try {
      const scores: OwnershipScore[] = await ownership.query({ path: relPath, limit });
      owners = scores.map((s) => ({ actor: s.actor, score: s.score }));
    } catch {
      // file not tracked by git or other query failure — return empty owners
    }
    return { path: relPath, name, isDir: false, owners };
  }

  // Directory node
  if (depth <= 0) {
    return { path: relPath, name, isDir: true, children: [] };
  }

  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const children: OwnershipNode[] = [];

  for (const entry of entries) {
    if (entry.name === '.git') continue;
    if (entry.isSymbolicLink()) continue;

    const childRel = relPath === '.' ? entry.name : nodePath.join(relPath, entry.name);
    const childAbs = nodePath.join(absPath, entry.name);

    if (entry.isDirectory()) {
      children.push(await buildOwnershipTree(ownership, childAbs, childRel, depth - 1, limit));
    } else if (entry.isFile()) {
      let owners: Array<{ actor: string; score: number }> = [];
      try {
        const scores: OwnershipScore[] = await ownership.query({ path: childRel, limit });
        owners = scores.map((s) => ({ actor: s.actor, score: s.score }));
      } catch {
        // not tracked — empty owners
      }
      children.push({ path: childRel, name: entry.name, isDir: false, owners });
    }
  }

  return { path: relPath, name, isDir: true, children };
}

export function queryRoutes(ownership: OwnershipService, options: QueryRouteOptions = {}): Router {
  const router = Router();

  // Bearer auth (same pattern as observe.ts)
  if (options.bearerToken) {
    const expected = `Bearer ${options.bearerToken}`;
    router.use('/api/query', (req, res, next) => {
      if (req.headers.authorization !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
  }

  const OwnershipQuerySchema = z.object({
    path: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });

  router.get('/api/query/ownership', async (req, res, next) => {
    try {
      const query = OwnershipQuerySchema.parse(req.query);
      const results = await ownership.query({
        path: query.path,
        limit: query.limit,
      });
      res.json(results);
    } catch (err) {
      next(err);
    }
  });

  // --- Ownership tree endpoint ---

  const OwnershipTreeQuerySchema = z.object({
    path: z.string().min(1).default('.'),
    depth: z.coerce.number().int().min(1).max(5).default(2),
    limit: z.coerce.number().int().min(1).max(50).default(3),
  });

  router.get('/api/query/ownership-tree', async (req, res, next) => {
    try {
      const query = OwnershipTreeQuerySchema.parse(req.query);
      const absPath = nodePath.join(ownership.root, query.path);

      if (!fs.existsSync(absPath)) {
        res.status(404).json({ error: 'path-not-found', path: query.path });
        return;
      }

      const tree = await buildOwnershipTree(
        ownership,
        absPath,
        query.path,
        query.depth,
        query.limit,
      );
      res.json(tree);
    } catch (err) {
      next(err);
    }
  });

  // --- Parallel work endpoint ---

  const ParallelWorkQuerySchema = z.object({
    branch: z.string().optional(),
    namespace: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  router.get('/api/query/parallel-work', (req, res, next) => {
    try {
      if (!options.brain) {
        res.status(503).json({ error: 'brain-not-configured' });
        return;
      }
      const query = ParallelWorkQuerySchema.parse(req.query);
      const users = options.users ?? null;
      const ns = resolveScopedNamespace(req, res, query.namespace, users);
      if (ns === null) return;
      const rows = options.brain.findParallelWork({
        branch: query.branch ?? undefined,
        namespace: ns ?? undefined,
        limit: query.limit,
      });
      const conflicts = rows.map((row) => ({
        entityId: row.entityId,
        entityName: row.entityName,
        entityType: row.entityType,
        namespace: row.namespace,
        actors: row.actors,
        branches: row.branches,
      }));
      res.json({ conflicts });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
