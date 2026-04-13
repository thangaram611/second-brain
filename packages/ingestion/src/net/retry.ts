export interface RetryOptions {
  /** Maximum total attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Initial backoff in milliseconds. Default 500. */
  initialDelayMs?: number;
  /** Upper bound on a single backoff in milliseconds. Default 10000. */
  maxDelayMs?: number;
  /** Exponential base. Default 2 (doubles each attempt). */
  factor?: number;
  /** Jitter fraction in [0, 1]. 0.3 = up to ±30% of the computed delay. Default 0.3. */
  jitter?: number;
  /** Return true if the thrown error is worth retrying. Default: retry 5xx/429/network errors. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Observability hook invoked before each retry sleep. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Abort cooperative retries. Pending sleeps are interrupted. */
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<RetryOptions, 'onRetry' | 'signal' | 'shouldRetry'>> & {
  shouldRetry: NonNullable<RetryOptions['shouldRetry']>;
} = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: 0.3,
  shouldRetry: defaultShouldRetry,
};

export function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  const status = extractStatus(err);
  if (status !== null) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // No HTTP status → likely a network or DNS failure. Worth one retry.
  return true;
}

function extractStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return null;
}

export function computeBackoff(attempt: number, opts: Required<Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'>>): number {
  const base = Math.min(opts.maxDelayMs, opts.initialDelayMs * Math.pow(opts.factor, attempt - 1));
  if (opts.jitter <= 0) return base;
  const spread = base * opts.jitter;
  return Math.max(0, base + (Math.random() * 2 - 1) * spread);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` with exponential backoff + jitter. Retries only when `shouldRetry`
 * returns true (default covers transient network and HTTP 5xx/429 failures).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const resolved = {
    maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
    initialDelayMs: options.initialDelayMs ?? DEFAULTS.initialDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
    factor: options.factor ?? DEFAULTS.factor,
    jitter: options.jitter ?? DEFAULTS.jitter,
    shouldRetry: options.shouldRetry ?? DEFAULTS.shouldRetry,
    onRetry: options.onRetry,
    signal: options.signal,
  };

  if (resolved.maxAttempts < 1) throw new Error('maxAttempts must be >= 1');

  let lastErr: unknown;
  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === resolved.maxAttempts;
      if (isLast || !resolved.shouldRetry(err, attempt)) throw err;
      const delay = computeBackoff(attempt, resolved);
      resolved.onRetry?.(err, attempt, delay);
      await sleep(delay, resolved.signal);
    }
  }
  throw lastErr;
}
