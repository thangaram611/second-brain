/**
 * Shared webhook delivery-verification primitives for git providers.
 *
 * These collapse the byte-identical header lookup + timing-safe compare
 * idiom that GitHub, GitLab, and Custom providers each carried inline.
 * Internal to the providers/ directory — NOT re-exported from index.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { VerificationResult } from './git-provider.js';

/** Case-insensitive header lookup; returns the first element for array values. */
export function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const needle = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== needle) continue;
    if (Array.isArray(v)) return v[0];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Constant-time string compare for plaintext tokens (GitLab / custom token mode).
 * Length check first: `timingSafeEqual` throws on unequal length. Leaking length
 * is acceptable here — secret token lengths are public constants.
 */
export function verifyToken(received: string, expected: string): VerificationResult {
  if (received.length !== expected.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected))
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

/**
 * Constant-time HMAC compare (GitHub HMAC-SHA256, custom hmac mode). Computes
 * the digest over `rawBody`, prepends `prefix` (e.g. 'sha256=') if given, then
 * length-checks before the timing-safe compare.
 */
export function verifyHmac(opts: {
  received: string;
  rawBody: Buffer;
  secret: string;
  algorithm: 'sha256' | 'sha1';
  prefix?: string;
}): VerificationResult {
  const digest = createHmac(opts.algorithm, opts.secret).update(opts.rawBody).digest('hex');
  const expected = opts.prefix ? `${opts.prefix}${digest}` : digest;
  if (opts.received.length !== expected.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(Buffer.from(opts.received), Buffer.from(expected))
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

// ─── HTTP error helpers ─────────────────────────────────────────────────────

/** Carries the HTTP status alongside the message so callers can branch on 404. */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Build an HttpError from a failed fetch Response. */
export function httpError(res: Response, ctx: string, label: 'GitHub' | 'GitLab'): HttpError {
  return new HttpError(`${label} API ${res.status} ${res.statusText} for ${ctx}`, res.status);
}

const StatusErrorSchema = z.object({ status: z.number() });

/** Zod-guarded status extraction — replaces `(err as { status: number }).status`. */
export function statusOf(err: unknown): number | undefined {
  const parsed = StatusErrorSchema.safeParse(err);
  return parsed.success ? parsed.data.status : undefined;
}
