import type { Request, Response, NextFunction } from 'express';

export interface TokenBucketOptions {
  /** Max burst (bucket capacity). */
  burst: number;
  /** Sustained refill rate per second. */
  sustained: number;
  /** How to extract a key from the request; drop request if null. */
  keyFn: (req: Request) => string | null;
  /** Called when a request is dropped. */
  onDropped?: (key: string) => void;
}

/**
 * Simple in-memory token-bucket rate limiter keyed by caller. On overflow
 * responds 429 and invokes onDropped. Forgets empty buckets opportunistically
 * to avoid unbounded memory when many short-lived sessions come through.
 */
export function tokenBucket(options: TokenBucketOptions) {
  interface Bucket {
    tokens: number;
    updatedAt: number;
  }
  const buckets: Map<string, Bucket> = new Map();

  return function middleware(req: Request, res: Response, next: NextFunction): void {
    const key = options.keyFn(req);
    if (key === null) {
      next();
      return;
    }
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: options.burst, updatedAt: now };
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(options.burst, bucket.tokens + elapsedSec * options.sustained);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      options.onDropped?.(key);
      res.status(429).json({ error: 'rate_limited', key });
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);

    // Drop completely-full idle buckets once they refill to prevent leaks.
    if (bucket.tokens >= options.burst - 0.5 && buckets.size > 1000) {
      for (const [k, b] of buckets) {
        if (b.tokens >= options.burst - 0.5 && now - b.updatedAt > 60_000) {
          buckets.delete(k);
        }
      }
    }

    next();
  };
}
