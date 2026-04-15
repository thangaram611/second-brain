import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

/**
 * Webhook relay — forwards payloads from a public smee.io (or self-
 * hosted) channel into the local `/api/observe/mr-event` endpoint.
 *
 * The relay client itself is intentionally thin: it receives a JSON body
 * plus a whitelist of inbound headers, forwards them via a plain `fetch`,
 * and spills to a local disk queue when the downstream returns 429
 * (plan revision #14). On daemon start, `drainQueuedDeliveries` replays
 * everything in the queue before new live events are accepted.
 *
 * We do NOT take a direct runtime dependency on `smee-client` in this
 * package — the daemon (`brain watch`) injects a relay source via the
 * `source` callback shape, which lets tests drive delivery without
 * spinning up smee. The production adapter lives in `tools/cli/src/
 * git-context-daemon.ts`.
 */

const QUEUE_FILE = path.join(os.homedir(), '.second-brain', 'providers', 'gitlab-queue.jsonl');
const QUEUE_DIR = path.dirname(QUEUE_FILE);
const MAX_QUEUE_BYTES = 10 * 1024 * 1024;

const QueuedDeliverySchema = z.object({
  version: z.literal(1),
  targetUrl: z.string(),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
  enqueuedAt: z.string(),
});
export type QueuedDelivery = z.infer<typeof QueuedDeliverySchema>;

export interface RelayForwardInput {
  targetUrl: string;
  body: string;
  headers: Record<string, string>;
}

export interface RelayForwardOutput {
  status: number;
  queued: boolean;
}

export interface RelayClient {
  forward(input: RelayForwardInput): Promise<RelayForwardOutput>;
  drainQueue(): Promise<{ delivered: number; requeued: number }>;
}

export interface CreateRelayClientOptions {
  fetchImpl?: typeof fetch;
  queueFile?: string;
}

export function createRelayClient(opts: CreateRelayClientOptions = {}): RelayClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const queueFile = opts.queueFile ?? QUEUE_FILE;

  return {
    async forward(input: RelayForwardInput): Promise<RelayForwardOutput> {
      let res: Response;
      try {
        res = await fetchImpl(input.targetUrl, {
          method: 'POST',
          body: input.body,
          headers: input.headers,
        });
      } catch (err) {
        // Connection error — treat as temporarily unavailable, queue it.
        enqueue(queueFile, {
          version: 1,
          targetUrl: input.targetUrl,
          body: input.body,
          headers: input.headers,
          enqueuedAt: new Date().toISOString(),
        });
        throw err;
      }
      if (res.status === 429) {
        enqueue(queueFile, {
          version: 1,
          targetUrl: input.targetUrl,
          body: input.body,
          headers: input.headers,
          enqueuedAt: new Date().toISOString(),
        });
        return { status: 429, queued: true };
      }
      return { status: res.status, queued: false };
    },

    async drainQueue(): Promise<{ delivered: number; requeued: number }> {
      if (!fs.existsSync(queueFile)) return { delivered: 0, requeued: 0 };
      const entries = readQueueEntries(queueFile);
      fs.writeFileSync(queueFile, '', 'utf8');
      let delivered = 0;
      let requeued = 0;
      for (const entry of entries) {
        try {
          const res = await fetchImpl(entry.targetUrl, {
            method: 'POST',
            body: entry.body,
            headers: entry.headers,
          });
          if (res.status === 429 || !res.ok) {
            enqueue(queueFile, entry);
            requeued++;
          } else {
            delivered++;
          }
        } catch {
          enqueue(queueFile, entry);
          requeued++;
        }
      }
      return { delivered, requeued };
    },
  };
}

function enqueue(queueFile: string, entry: QueuedDelivery): void {
  try {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    // Rotation: if the file exceeds MAX_QUEUE_BYTES, truncate oldest
    // (stream-read + stream-write a trimmed version). Quick + good enough
    // since "huge queue" already indicates a crisis.
    try {
      const stat = fs.statSync(queueFile);
      if (stat.size > MAX_QUEUE_BYTES) {
        const entries = readQueueEntries(queueFile);
        const half = entries.slice(Math.floor(entries.length / 2));
        fs.writeFileSync(queueFile, '', 'utf8');
        for (const e of half) fs.appendFileSync(queueFile, JSON.stringify(e) + '\n', 'utf8');
      }
    } catch {
      // queueFile may not exist yet — fall through.
    }
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Last-ditch: drop silently. Tests cover the happy path; the relay
    // won't crash the daemon if disk is full.
  }
}

function readQueueEntries(queueFile: string): QueuedDelivery[] {
  const out: QueuedDelivery[] = [];
  const raw = fs.readFileSync(queueFile, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = QueuedDeliverySchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // Skip malformed lines — don't block the drain.
    }
  }
  return out;
}

// ─── smee.io channel management ───────────────────────────────────────────

/**
 * Mint a new smee.io channel, or resolve the configured self-hosted
 * relay URL. Returns the URL to register with GitLab.
 *
 * Environment:
 *   `SECOND_BRAIN_RELAY_URL` — if set, returned as-is and smee.io is
 *   not contacted. Use this to point at a private relay inside a
 *   corporate VPN.
 */
export async function mintRelayChannel(opts: {
  fetchImpl?: typeof fetch;
} = {}): Promise<string> {
  const override = process.env.SECOND_BRAIN_RELAY_URL;
  if (typeof override === 'string' && override.length > 0) return override;

  const fetchImpl = opts.fetchImpl ?? fetch;
  // smee.io responds with 302 Location: https://smee.io/<channel>
  const res = await fetchImpl('https://smee.io/new', {
    method: 'HEAD',
    redirect: 'manual',
  });
  const loc = res.headers.get('location');
  if (typeof loc !== 'string' || loc.length === 0) {
    throw new Error('smee.io did not return a channel URL');
  }
  return loc;
}

export const QUEUE_FILE_PATH = QUEUE_FILE;
export const QUEUE_DIR_PATH = QUEUE_DIR;
