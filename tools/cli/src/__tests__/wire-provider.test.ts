import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWire } from '../wire.js';
import { runUnwire } from '../unwire.js';
import { loadWiredRepos } from '../git-context-daemon.js';
import { setKeychainTestOverride, resetKeychainCache } from '../keychain.js';
import { GitLabProvider } from '@second-brain/collectors';

let tmpRepo: string;
let tmpHome: string;
let savedHome: string | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function swapHome(newHome: string): void {
  savedHome = process.env.HOME;
  process.env.HOME = newHome;
}

function restoreHome(): void {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  savedHome = undefined;
}

function inMemoryKeytar() {
  const store = new Map<string, string>();
  const key = (service: string, account: string): string => `${service}::${account}`;
  return {
    async setPassword(service: string, account: string, password: string): Promise<void> {
      store.set(key(service, account), password);
    },
    async getPassword(service: string, account: string): Promise<string | null> {
      return store.get(key(service, account)) ?? null;
    },
    async deletePassword(service: string, account: string): Promise<boolean> {
      return store.delete(key(service, account));
    },
    _store: store,
  };
}

function mockGitLabFetch(options: {
  onRegister?: () => void;
  registerResponseStatus?: number;
  existingHooks?: Array<{ id: number; url: string }>;
} = {}) {
  const existing = options.existingHooks ?? [];
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/user')) {
      return new Response(JSON.stringify({ id: 1, username: 'alice' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/personal_access_tokens/self')) {
      return new Response(JSON.stringify({ scopes: ['api'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/projects/acme%2Frepo')) {
      return new Response(
        JSON.stringify({ id: 123, path_with_namespace: 'acme/repo', default_branch: 'main' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/hooks')) {
      if (method === 'GET') {
        return new Response(JSON.stringify(existing), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST') {
        options.onRegister?.();
        return new Response(JSON.stringify({ id: 777, url: 'https://private-relay.example' }), {
          status: options.registerResponseStatus ?? 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    if (url.startsWith('https://smee.io')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://smee.io/test-channel' },
      });
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-prov-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wire-home-'));
  swapHome(tmpHome);
  git(['init', '-q', '-b', 'main'], tmpRepo);
  git(['config', 'user.email', 'test@example.com'], tmpRepo);
  git(['config', 'user.name', 'Test'], tmpRepo);
  git(['remote', 'add', 'origin', 'git@gitlab.example:acme/repo.git'], tmpRepo);
  resetKeychainCache();
  setKeychainTestOverride(inMemoryKeytar());
  process.env.SECOND_BRAIN_RELAY_URL = 'https://private-relay.example';
});

afterEach(() => {
  setKeychainTestOverride(null);
  restoreHome();
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.SECOND_BRAIN_RELAY_URL;
});

describe('brain wire + provider', () => {
  it('registers the webhook, stores secret, and records the wiredRepos entry', async () => {
    const fetchImpl = mockGitLabFetch();
    const result = await runWire({
      repo: tmpRepo,
      namespace: 'proj',
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl }),
      fetchImpl,
      installClaudeSession: false,
    });
    expect(result.providerResult).toBeTruthy();
    expect(result.providerResult?.webhookId).toBe(777);
    expect(result.providerResult?.webhookAlreadyExisted).toBe(false);

    const wired = loadWiredRepos();
    const entry = Object.values(wired.wiredRepos)[0];
    expect(entry.providerId).toBe('gitlab');
    expect(entry.projectId).toBe('123');
    expect(entry.webhookId).toBe(777);
    expect(entry.relayUrl).toBe('https://private-relay.example');
  });

  it('reuses an existing webhook by URL (SIGKILL recovery, rev #5)', async () => {
    const fetchImpl = mockGitLabFetch({
      existingHooks: [{ id: 888, url: 'https://private-relay.example' }],
    });
    const result = await runWire({
      repo: tmpRepo,
      namespace: 'proj',
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl }),
      fetchImpl,
      installClaudeSession: false,
    });
    expect(result.providerResult?.webhookId).toBe(888);
    expect(result.providerResult?.webhookAlreadyExisted).toBe(true);
  });

  it('concurrent-wire lock rejects a second invocation in the same process', async () => {
    // First wire call — succeeds.
    const fetch1 = mockGitLabFetch();
    const first = runWire({
      repo: tmpRepo,
      namespace: 'proj',
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl: fetch1 }),
      fetchImpl: fetch1,
      installClaudeSession: false,
    });
    // Second concurrent call should fail — the lock is already held.
    const fetch2 = mockGitLabFetch();
    const second = runWire({
      repo: tmpRepo,
      namespace: 'proj',
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl: fetch2 }),
      fetchImpl: fetch2,
      installClaudeSession: false,
    });
    // One should fail (the one that loses the lock race).
    const [firstRes, secondRes] = await Promise.allSettled([first, second]);
    const rejectedCount =
      (firstRes.status === 'rejected' ? 1 : 0) + (secondRes.status === 'rejected' ? 1 : 0);
    expect(rejectedCount).toBe(1);
    const rejection = firstRes.status === 'rejected' ? firstRes : secondRes.status === 'rejected' ? secondRes : null;
    if (!rejection || rejection.status !== 'rejected') throw new Error('expected a rejection');
    expect(String(rejection.reason)).toMatch(/wire operation is in progress/);
  });
});

describe('brain unwire', () => {
  it('removes webhook + keychain + wiredRepos entry on success', async () => {
    const fetchImpl = mockGitLabFetch();
    await runWire({
      repo: tmpRepo,
      namespace: 'proj',
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl }),
      fetchImpl,
      installClaudeSession: false,
    });

    const unwireFetch = mockGitLabFetch();
    const result = await runUnwire({
      repo: tmpRepo,
      gitlabProvider: new GitLabProvider({ fetchImpl: unwireFetch }),
      fetchImpl: unwireFetch,
    });
    expect(result.providerUnregistered).toBe(true);
    expect(result.configEntryRemoved).toBe(true);
    expect(result.keychainCleaned).toBeGreaterThanOrEqual(1);

    const wired = loadWiredRepos();
    expect(Object.keys(wired.wiredRepos)).toHaveLength(0);
  });

  it('--force succeeds on 401 from unregister', async () => {
    const fetchImpl = mockGitLabFetch();
    await runWire({
      repo: tmpRepo,
      namespace: 'proj',
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl }),
      fetchImpl,
      installClaudeSession: false,
    });

    const unauthFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ message: 'unauth' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    const result = await runUnwire({
      repo: tmpRepo,
      force: true,
      gitlabProvider: new GitLabProvider({ fetchImpl: unauthFetch }),
      fetchImpl: unauthFetch,
    });
    expect(result.providerUnregistered).toBe(false);
    expect(result.configEntryRemoved).toBe(true);
    expect(result.warnings.some((w) => w.includes('unregister failed'))).toBe(true);
  });
});
