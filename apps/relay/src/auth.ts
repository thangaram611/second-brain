import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

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

    if (secret !== authSecret) {
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
