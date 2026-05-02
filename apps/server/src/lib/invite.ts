/**
 * Invite token sign/verify (HMAC-SHA256).
 *
 * Format: `<base64url(payload)>.<base64url(hmacSHA256(payload))>`
 * payload = `{ jti, namespace, role, scopes, exp }` (JSON, base64url-encoded)
 *
 * Verification is timing-safe.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const InvitePayloadSchema = z.object({
  jti: z.string().min(8),
  namespace: z.string().min(1),
  role: z.enum(['member', 'admin']),
  scopes: z.array(z.string()).default([]),
  exp: z.number().int().positive(),
});
export type InvitePayload = z.infer<typeof InvitePayloadSchema>;

export interface SignedInvite {
  token: string;
  payload: InvitePayload;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64url(input: string): Buffer {
  const pad = (4 - (input.length % 4)) % 4;
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

function hmac(signingKey: string, payload: string): Buffer {
  return createHmac('sha256', signingKey).update(payload).digest();
}

export function newJti(): string {
  return randomBytes(12).toString('hex');
}

export function signInvite(payload: InvitePayload, signingKey: string): string {
  const validated = InvitePayloadSchema.parse(payload);
  const json = JSON.stringify(validated);
  const encodedPayload = base64url(json);
  const sig = hmac(signingKey, encodedPayload);
  const encodedSig = base64url(sig);
  return `${encodedPayload}.${encodedSig}`;
}

export type InviteVerifyError =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'invalid-payload';

export interface InviteVerifyOk {
  ok: true;
  payload: InvitePayload;
}
export interface InviteVerifyFail {
  ok: false;
  error: InviteVerifyError;
}
export type InviteVerifyResult = InviteVerifyOk | InviteVerifyFail;

export function verifyInvite(
  token: string,
  signingKey: string,
  opts?: { now?: () => number },
): InviteVerifyResult {
  const now = opts?.now ?? Date.now;
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'malformed' };
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return { ok: false, error: 'malformed' };

  const expectedSig = hmac(signingKey, encodedPayload);
  let providedSig: Buffer;
  try {
    providedSig = fromBase64url(encodedSig);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, error: 'bad-signature' };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, error: 'bad-signature' };
  }

  let parsed: unknown;
  try {
    const json = fromBase64url(encodedPayload).toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'malformed' };
  }

  const result = InvitePayloadSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: 'invalid-payload' };

  const payload = result.data;
  if (payload.exp * 1000 <= now()) {
    return { ok: false, error: 'expired' };
  }

  return { ok: true, payload };
}
