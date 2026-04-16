import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OwnershipScore } from '../ownership.js';

const mockScores: OwnershipScore[] = [
  {
    actor: 'alice',
    score: 0.65,
    signals: {
      commits: 42,
      recencyWeightedBlameLines: 320.5,
      reviews: 8,
      testAuthorship: 15,
      codeownerMatch: true,
    },
  },
  {
    actor: 'bob',
    score: 0.35,
    signals: {
      commits: 10,
      recencyWeightedBlameLines: 80.2,
      reviews: 3,
      testAuthorship: 2,
      codeownerMatch: false,
    },
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runOwnership', () => {
  it('makes GET request with path param', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockScores,
    });

    const { runOwnership } = await import('../ownership.js');
    await runOwnership({ path: 'src/main.ts', serverUrl: 'http://localhost:9999' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/query/ownership');
    expect(url).toContain('path=src%2Fmain.ts');
    expect(opts.headers).toEqual({});
  });

  it('passes limit in query string', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockScores,
    });

    const { runOwnership } = await import('../ownership.js');
    await runOwnership({ path: 'src/main.ts', limit: 5, serverUrl: 'http://localhost:9999' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=5');
  });

  it('sends bearer token header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockScores,
    });

    const { runOwnership } = await import('../ownership.js');
    await runOwnership({ path: 'src/main.ts', token: 'secret-tok', serverUrl: 'http://localhost:9999' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-tok');
  });

  it('outputs valid JSON in json mode', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockScores,
    });

    const { runOwnership } = await import('../ownership.js');
    await runOwnership({ path: 'src/main.ts', json: true, serverUrl: 'http://localhost:9999' });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].actor).toBe('alice');
  });

  it('handles error response gracefully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    });

    const { runOwnership } = await import('../ownership.js');
    await expect(
      runOwnership({ path: 'nope.ts', serverUrl: 'http://localhost:9999' }),
    ).rejects.toThrow('process.exit');

    expect(errorSpy).toHaveBeenCalledWith('Error: 404 — Not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows message when no ownership data found', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const { runOwnership } = await import('../ownership.js');
    await runOwnership({ path: 'empty.ts', serverUrl: 'http://localhost:9999' });

    expect(logSpy).toHaveBeenCalledWith('No ownership data found for empty.ts');
  });

  it('formats table output for multiple owners', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockScores,
    });

    const { runOwnership } = await import('../ownership.js');
    await runOwnership({ path: 'src/main.ts', serverUrl: 'http://localhost:9999' });

    const allOutput = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(allOutput).toContain('alice  (65.0%)');
    expect(allOutput).toContain('bob  (35.0%)');
    expect(allOutput).toContain('codeowner: yes');
    expect(allOutput).toContain('codeowner: no');
  });
});
