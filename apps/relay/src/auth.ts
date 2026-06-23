import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * Constant-time shared-secret comparison. Both inputs are hashed to a fixed
 * 32-byte digest first so `timingSafeEqual` always gets equal-length buffers
 * (it throws on a length mismatch) and the check leaks neither the secret's
 * bytes nor its length via timing.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const AuthRequestSchema = z.object({
  namespace: z.string().min(1),
  userName: z.string().min(1),
  secret: z.string().min(1),
});

const TOKEN_EXPIRY_SECONDS = 86_400; // 24 hours

/**
 * Create an Express router that issues JWT tokens for relay authentication.
 *
 * POST /auth/token — validates the shared secret, then returns a signed JWT
 * containing sub, namespace, and permissions.
 */
export function createAuthRouter(authSecret: string): Router {
  const router = Router();

  router.post('/auth/token', (req, res) => {
    const parsed = AuthRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }

    const { namespace, userName, secret } = parsed.data;

    if (!secretsMatch(secret, authSecret)) {
      res.status(401).json({ error: 'Invalid secret' });
      return;
    }

    const payload = {
      sub: userName,
      namespace,
      permissions: ['read', 'write'] satisfies ('read' | 'write')[],
    };

    const token = jwt.sign(payload, authSecret, { expiresIn: TOKEN_EXPIRY_SECONDS });

    res.json({ token, expiresIn: TOKEN_EXPIRY_SECONDS });
  });

  return router;
}
