export interface PostClientOptions {
  baseUrl?: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ObservePath =
  | '/api/observe/session-start'
  | '/api/observe/prompt-submit'
  | '/api/observe/tool-use'
  | '/api/observe/stop'
  | '/api/observe/session-end';

/**
 * Thin HTTP client for the apps/server observation endpoints. Used by the
 * Copilot + Codex adapters to replay events into the same pipeline Claude
 * Code's hook binary uses.
 */
export class PostClient {
  private readonly baseUrl: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PostClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${process.env.BRAIN_API_PORT ?? '7430'}`;
    this.bearerToken = options.bearerToken ?? process.env.BRAIN_AUTH_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async post(path: ObservePath, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`POST ${path} ${res.status}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  }
}
