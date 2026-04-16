import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { SSERelayEvent } from '../sse-relay.js';

// ── Fake EventSource ──────────────────────────────────────────────────

type ESListener = (evt: { data?: string; type: string }) => void;

class FakeEventSource {
  static instance: FakeEventSource | null = null;

  readonly url: string;
  readyState = 0; // CONNECTING
  private listeners = new Map<string, ESListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instance = this;
  }

  addEventListener(type: string, cb: ESListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  // ── test helpers ──

  emit(type: string, data?: string): void {
    const list = this.listeners.get(type) ?? [];
    for (const cb of list) {
      cb({ data, type });
    }
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.emit('open');
  }

  simulateMessage(payload: unknown): void {
    this.emit('message', JSON.stringify(payload));
  }

  simulateError(): void {
    this.readyState = 0;
    this.emit('error');
  }
}

// ── Stub global EventSource ───────────────────────────────────────────

const origEventSource = globalThis.EventSource;

beforeEach(() => {
  FakeEventSource.instance = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = FakeEventSource;
});

afterEach(() => {
  if (origEventSource !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).EventSource = origEventSource;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).EventSource;
  }
});

// Dynamically import so the module picks up the patched EventSource.
async function loadRelay() {
  const mod = await import('../sse-relay.js');
  return mod;
}

// ── smee.io payload helper ────────────────────────────────────────────

function smeePayload(overrides: Partial<{
  body: unknown;
  headers: Record<string, string>;
  timestamp: number;
}> = {}) {
  return {
    body: overrides.body ?? { action: 'opened', pull_request: { id: 1 } },
    headers: overrides.headers ?? { 'x-github-event': 'pull_request', 'x-github-delivery': 'gh-abc-123' },
    query: {},
    timestamp: overrides.timestamp ?? 1700000000000,
  };
}

function okFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('startSSERelay', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = okFetch();
  });

  it('returns a handle and calls onConnected', async () => {
    const { startSSERelay } = await loadRelay();
    const onConnected = vi.fn();
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test-channel',
      targetUrl: 'http://localhost:4100/api/observe/mr-event',
      fetchImpl: fetchMock,
      onConnected,
    });

    expect(handle).toBeDefined();
    expect(handle.connected).toBe(false);
    expect(handle.eventCount).toBe(0);

    FakeEventSource.instance!.simulateOpen();
    expect(handle.connected).toBe(true);
    expect(onConnected).toHaveBeenCalledOnce();

    handle.close();
  });

  it('connects to the correct channel URL', async () => {
    const { startSSERelay } = await loadRelay();
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/my-channel',
      targetUrl: 'http://localhost:4100/api/observe/mr-event',
      fetchImpl: fetchMock,
    });

    expect(FakeEventSource.instance!.url).toBe('https://smee.io/my-channel');
    handle.close();
  });

  it('forwards webhook events via fetch', async () => {
    const { startSSERelay } = await loadRelay();
    const events: SSERelayEvent[] = [];
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/api/observe/mr-event',
      headers: { Authorization: 'Bearer tok-123' },
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e),
    });

    FakeEventSource.instance!.simulateOpen();
    FakeEventSource.instance!.simulateMessage(smeePayload());

    // Allow async handler to run
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:4100/api/observe/mr-event');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      action: 'opened',
      pull_request: { id: 1 },
    });
    // Auth header merged with webhook headers
    expect(init!.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-123',
      'x-github-event': 'pull_request',
    });

    const event = events[0]!;
    expect(event.deliveryId).toBe('gh-abc-123');
    expect(event.provider).toBe('github');
    expect(event.forwarded).toBe(true);

    handle.close();
  });

  it('increments eventCount on each message', async () => {
    const { startSSERelay } = await loadRelay();
    const events: SSERelayEvent[] = [];
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e),
    });

    FakeEventSource.instance!.simulateOpen();
    FakeEventSource.instance!.simulateMessage(smeePayload());
    FakeEventSource.instance!.simulateMessage(smeePayload({ timestamp: 1700000001000 }));
    FakeEventSource.instance!.simulateMessage(smeePayload({ timestamp: 1700000002000 }));

    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(handle.eventCount).toBe(3);

    handle.close();
  });

  it('detects GitLab provider from headers', async () => {
    const { startSSERelay } = await loadRelay();
    const events: SSERelayEvent[] = [];
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e),
    });

    FakeEventSource.instance!.simulateOpen();
    FakeEventSource.instance!.simulateMessage(smeePayload({
      headers: { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': 'secret' },
    }));

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.provider).toBe('gitlab');

    handle.close();
  });

  it('falls back to custom provider for unknown headers', async () => {
    const { startSSERelay } = await loadRelay();
    const events: SSERelayEvent[] = [];
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e),
    });

    FakeEventSource.instance!.simulateOpen();
    FakeEventSource.instance!.simulateMessage(smeePayload({
      headers: { 'x-custom-header': 'value' },
    }));

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.provider).toBe('custom');

    handle.close();
  });

  it('calls onError when EventSource errors', async () => {
    const { startSSERelay } = await loadRelay();
    const onError = vi.fn();
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onError,
    });

    FakeEventSource.instance!.simulateOpen();
    expect(handle.connected).toBe(true);

    FakeEventSource.instance!.simulateError();
    expect(handle.connected).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]![0].message).toBe('EventSource connection error');

    handle.close();
  });

  it('close() shuts down EventSource and marks disconnected', async () => {
    const { startSSERelay } = await loadRelay();
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
    });

    FakeEventSource.instance!.simulateOpen();
    expect(handle.connected).toBe(true);

    handle.close();
    expect(handle.connected).toBe(false);
    expect(FakeEventSource.instance!.readyState).toBe(2); // CLOSED
  });

  it('calls onReconnect (not onConnected) after error then open', async () => {
    const { startSSERelay } = await loadRelay();
    const onConnected = vi.fn();
    const onReconnect = vi.fn();
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onConnected,
      onReconnect,
    });

    // First connect
    FakeEventSource.instance!.simulateOpen();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalled();

    // Disconnect
    FakeEventSource.instance!.simulateError();
    expect(handle.connected).toBe(false);

    // Reconnect
    FakeEventSource.instance!.simulateOpen();
    expect(handle.connected).toBe(true);
    expect(onConnected).toHaveBeenCalledOnce(); // still 1
    expect(onReconnect).toHaveBeenCalledOnce();

    handle.close();
  });

  it('marks forwarded=false when fetch throws', async () => {
    fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED'); });

    const { startSSERelay } = await loadRelay();
    const events: SSERelayEvent[] = [];
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e),
    });

    FakeEventSource.instance!.simulateOpen();
    FakeEventSource.instance!.simulateMessage(smeePayload());

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.forwarded).toBe(false);
    expect(handle.eventCount).toBe(1);

    handle.close();
  });

  it('calls onError when message JSON is invalid', async () => {
    const { startSSERelay } = await loadRelay();
    const onError = vi.fn();
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onError,
    });

    FakeEventSource.instance!.simulateOpen();
    // Emit raw invalid JSON
    FakeEventSource.instance!.emit('message', 'not valid json{{{');

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);

    handle.close();
  });

  it('generates a fallback delivery ID when header is absent', async () => {
    const { startSSERelay } = await loadRelay();
    const events: SSERelayEvent[] = [];
    const handle = startSSERelay({
      channelUrl: 'https://smee.io/test',
      targetUrl: 'http://localhost:4100/target',
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e),
    });

    FakeEventSource.instance!.simulateOpen();
    FakeEventSource.instance!.simulateMessage(smeePayload({
      headers: {},
      timestamp: 1700000099000,
    }));

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.deliveryId).toBe('relay-1700000099000');

    handle.close();
  });
});
