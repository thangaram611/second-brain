/**
 * SSE relay client — connects to a smee.io channel URL and forwards
 * incoming webhook events to a local server endpoint via `fetch`.
 *
 * Uses the built-in `EventSource` available in Node.js 22+.
 * Auto-reconnection is handled natively by EventSource.
 */

export interface SSERelayOptions {
  /** smee.io channel URL (e.g., https://smee.io/abc123) */
  channelUrl: string;
  /** Local target URL (e.g., http://localhost:4100/api/observe/mr-event) */
  targetUrl: string;
  /** Auth headers to include when forwarding */
  headers?: Record<string, string>;
  /** Called on each forwarded event */
  onEvent?: (event: SSERelayEvent) => void;
  /** Called on connection errors */
  onError?: (err: Error) => void;
  /** Called when connected */
  onConnected?: () => void;
  /** Called on reconnect */
  onReconnect?: () => void;
  /** Override fetch for testing */
  fetchImpl?: typeof fetch;
}

export interface SSERelayEvent {
  deliveryId: string;
  provider: string;
  timestamp: string;
  forwarded: boolean;
}

export interface SSERelayHandle {
  close(): void;
  readonly connected: boolean;
  readonly eventCount: number;
}

/**
 * Detect the forge provider from inbound webhook headers.
 * Falls back to `'custom'` when unrecognised.
 */
function detectProvider(headers: Record<string, string>): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  if (lower['x-github-event'] || lower['x-github-delivery']) return 'github';
  if (lower['x-gitlab-event'] || lower['x-gitlab-token']) return 'gitlab';
  return 'custom';
}

/**
 * Extract a stable delivery ID from inbound headers, falling back to a
 * timestamp-based value when the forge header is absent.
 */
function extractDeliveryId(headers: Record<string, string>, timestamp: number): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return (
    lower['x-github-delivery'] ??
    lower['x-gitlab-webhook-uuid'] ??
    `relay-${timestamp}`
  );
}

/**
 * Start an SSE relay that listens on a smee.io channel and forwards
 * each webhook delivery to the local target URL.
 *
 * The forwarding shape matches the `RelayForwardInput` pattern from
 * `@second-brain/collectors` webhook-relay: the original body is sent
 * as a JSON string with the original headers.
 */
export function startSSERelay(options: SSERelayOptions): SSERelayHandle {
  const fetchFn = options.fetchImpl ?? fetch;

  let _connected = false;
  let _eventCount = 0;
  let _hasConnectedBefore = false;

  const es = new EventSource(options.channelUrl);

  es.addEventListener('open', () => {
    const wasReconnect = _hasConnectedBefore;
    _connected = true;
    _hasConnectedBefore = true;
    if (wasReconnect) {
      options.onReconnect?.();
    } else {
      options.onConnected?.();
    }
  });

  es.addEventListener('message', (evt: MessageEvent) => {
    void (async () => {
      try {
        const smeePayload = JSON.parse(String(evt.data)) as {
          body?: unknown;
          headers?: Record<string, string>;
          query?: Record<string, string>;
          timestamp?: number;
        };

        const webhookBody = smeePayload.body ?? {};
        const webhookHeaders = smeePayload.headers ?? {};
        const ts = smeePayload.timestamp ?? Date.now();

        const provider = detectProvider(webhookHeaders);
        const deliveryId = extractDeliveryId(webhookHeaders, ts);
        const bodyStr = JSON.stringify(webhookBody);

        let forwarded = false;
        try {
          await fetchFn(options.targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...webhookHeaders,
              ...options.headers,
            },
            body: bodyStr,
          });
          forwarded = true;
        } catch {
          // Forward failure is non-fatal — the webhook-relay disk queue
          // (or the caller's onEvent handler) can deal with retries.
        }

        _eventCount++;
        options.onEvent?.({
          deliveryId,
          provider,
          timestamp: new Date(ts).toISOString(),
          forwarded,
        });
      } catch (err) {
        options.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();
  });

  es.addEventListener('error', () => {
    _connected = false;
    options.onError?.(new Error('EventSource connection error'));
  });

  return {
    close() {
      es.close();
      _connected = false;
    },
    get connected() {
      return _connected;
    },
    get eventCount() {
      return _eventCount;
    },
  };
}
