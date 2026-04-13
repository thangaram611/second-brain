import { describe, it, expect, vi } from 'vitest';
import { withRetry, defaultShouldRetry, computeBackoff } from '../net/retry.js';

describe('computeBackoff', () => {
  it('doubles delay per attempt, capped at maxDelayMs, with jitter disabled', () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 0 };
    expect(computeBackoff(1, opts)).toBe(100);
    expect(computeBackoff(2, opts)).toBe(200);
    expect(computeBackoff(3, opts)).toBe(400);
    expect(computeBackoff(4, opts)).toBe(800);
    expect(computeBackoff(5, opts)).toBe(1000); // capped
    expect(computeBackoff(10, opts)).toBe(1000);
  });

  it('keeps delay within ±jitter fraction of the base', () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 0.5 };
    for (let i = 0; i < 50; i++) {
      const d = computeBackoff(2, opts); // base = 200, spread = 100 → [100, 300]
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(300);
    }
  });
});

describe('defaultShouldRetry', () => {
  it('retries on 429 and 5xx statuses', () => {
    expect(defaultShouldRetry({ status: 429 })).toBe(true);
    expect(defaultShouldRetry({ status: 500 })).toBe(true);
    expect(defaultShouldRetry({ status: 503 })).toBe(true);
  });

  it('does not retry on 4xx (except 429)', () => {
    expect(defaultShouldRetry({ status: 400 })).toBe(false);
    expect(defaultShouldRetry({ status: 401 })).toBe(false);
    expect(defaultShouldRetry({ status: 404 })).toBe(false);
  });

  it('retries on network-style errors with no status', () => {
    expect(defaultShouldRetry(new Error('ECONNRESET'))).toBe(true);
  });

  it('never retries abort errors', () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    expect(defaultShouldRetry(abortErr)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the result immediately when fn succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { initialDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retriable error up to maxAttempts and then succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('boom'), { status: 500 });
      return 'done';
    });

    const result = await withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      jitter: 0,
    });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('re-throws the original error after exhausting attempts', async () => {
    const err = Object.assign(new Error('still broken'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, jitter: 0 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retriable errors (respects shouldRetry=false)', async () => {
    const err = Object.assign(new Error('nope'), { status: 404 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxAttempts: 5, initialDelayMs: 1 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry with attempt number and delay before sleeping', async () => {
    const onRetry = vi.fn();
    const err = Object.assign(new Error('boom'), { status: 500 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    await withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, jitter: 0, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(err, 1, expect.any(Number));
  });

  it('honours an AbortSignal by interrupting a pending sleep', async () => {
    const controller = new AbortController();
    const err = Object.assign(new Error('boom'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    // Abort shortly after the first retry schedules a sleep.
    setTimeout(() => controller.abort(), 10);

    await expect(
      withRetry(fn, {
        maxAttempts: 10,
        initialDelayMs: 100,
        jitter: 0,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Aborted/);
  });
});
