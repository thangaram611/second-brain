import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRelayClient, mintRelayChannel } from '../providers/index.js';

let tmpQueue: string;

function makeQueuePath(): string {
  return path.join(os.tmpdir(), `brain-relay-queue-${Date.now()}-${Math.random()}.jsonl`);
}

beforeEach(() => {
  tmpQueue = makeQueuePath();
});

afterEach(() => {
  if (fs.existsSync(tmpQueue)) fs.unlinkSync(tmpQueue);
  delete process.env.SECOND_BRAIN_RELAY_URL;
});

function okResponse(): Response {
  return new Response(null, { status: 201 });
}

function rateLimited(): Response {
  return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
}

describe('webhook-relay client', () => {
  it('forwards body+headers and returns downstream status', async () => {
    const calls: Array<{ url: string; body: string; headers: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        body: String(init?.body ?? ''),
        headers: init?.headers,
      });
      return okResponse();
    });
    const relay = createRelayClient({ fetchImpl, queueFile: tmpQueue });
    const res = await relay.forward({
      targetUrl: 'http://localhost:7430/api/observe/mr-event',
      body: '{"foo":1}',
      headers: { 'x-gitlab-token': 'sec', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    expect(res.queued).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBe('{"foo":1}');
  });

  it('queues to disk on 429 and reports queued=true', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => rateLimited());
    const relay = createRelayClient({ fetchImpl, queueFile: tmpQueue });
    const res = await relay.forward({
      targetUrl: 'http://localhost:7430/api/observe/mr-event',
      body: '{"delivery":"d1"}',
      headers: { 'x-gitlab-token': 'sec' },
    });
    expect(res.status).toBe(429);
    expect(res.queued).toBe(true);
    const diskContent = fs.readFileSync(tmpQueue, 'utf8').trim();
    expect(diskContent.length).toBeGreaterThan(0);
    const parsed = JSON.parse(diskContent);
    expect(parsed.body).toBe('{"delivery":"d1"}');
  });

  it('queues to disk on connection error and rethrows', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED'); });
    const relay = createRelayClient({ fetchImpl, queueFile: tmpQueue });
    await expect(
      relay.forward({
        targetUrl: 'http://localhost:7430/api/observe/mr-event',
        body: '{"delivery":"d2"}',
        headers: {},
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    const disk = fs.readFileSync(tmpQueue, 'utf8').trim();
    expect(disk).toContain('d2');
  });

  it('drainQueue re-POSTs entries and clears the disk queue on success', async () => {
    fs.writeFileSync(
      tmpQueue,
      JSON.stringify({
        version: 1,
        targetUrl: 'http://localhost:7430/api/observe/mr-event',
        body: '{"k":1}',
        headers: {},
        enqueuedAt: '2026-04-15T00:00:00Z',
      }) + '\n',
      'utf8',
    );

    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    const relay = createRelayClient({ fetchImpl, queueFile: tmpQueue });
    const res = await relay.drainQueue();
    expect(res.delivered).toBe(1);
    expect(res.requeued).toBe(0);
    const post = fs.readFileSync(tmpQueue, 'utf8').trim();
    expect(post).toBe('');
  });

  it('drainQueue re-queues entries that fail again', async () => {
    fs.writeFileSync(
      tmpQueue,
      JSON.stringify({
        version: 1,
        targetUrl: 'http://localhost:7430/api/observe/mr-event',
        body: '{"k":1}',
        headers: {},
        enqueuedAt: '2026-04-15T00:00:00Z',
      }) + '\n',
      'utf8',
    );

    const fetchImpl = vi.fn<typeof fetch>(async () => rateLimited());
    const relay = createRelayClient({ fetchImpl, queueFile: tmpQueue });
    const res = await relay.drainQueue();
    expect(res.delivered).toBe(0);
    expect(res.requeued).toBe(1);
    const post = fs.readFileSync(tmpQueue, 'utf8').trim();
    const requeued = JSON.parse(post);
    expect(requeued.body).toBe('{"k":1}');
  });
});

describe('mintRelayChannel', () => {
  it('honors SECOND_BRAIN_RELAY_URL when set', async () => {
    process.env.SECOND_BRAIN_RELAY_URL = 'https://private-relay.example';
    const url = await mintRelayChannel();
    expect(url).toBe('https://private-relay.example');
  });

  it('follows smee.io 302 Location header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 302, headers: { location: 'https://smee.io/abcd1234' } }),
    );
    const url = await mintRelayChannel({ fetchImpl });
    expect(url).toBe('https://smee.io/abcd1234');
  });

  it('throws when smee.io returns no Location header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
    await expect(mintRelayChannel({ fetchImpl })).rejects.toThrow();
  });
});
