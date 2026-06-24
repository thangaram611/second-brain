import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWire } from '../wire.js';
import { runProviderRemove } from '../unwire.js';
import { loadWiredRepos } from '../git-context-daemon.js';
import { setKeychainTestOverride, resetKeychainCache } from '../keychain.js';
import { GitLabProvider } from '@second-brain/collectors';
import { registerProviderCommands } from '../commands/provider-cmd.js';
import { registerWireUnwireCommands } from '../commands/wire-unwire.js';

let tmpRepo: string;
let tmpHome: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

function mockGitLabFetch(options: { existingHooks?: Array<{ id: number; url: string }> } = {}) {
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
        return new Response(JSON.stringify({ id: 777, url: 'https://private-relay.example' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-prov-cmd-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-prov-home-'));
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
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.SECOND_BRAIN_RELAY_URL;
});

describe('brain provider command surface', () => {
  it('registers a `provider` group with add/refresh/remove and drops --provider from `wire`', () => {
    const program = new Command();
    registerWireUnwireCommands(program);
    registerProviderCommands(program);

    const wire = program.commands.find((c) => c.name() === 'wire');
    expect(wire).toBeTruthy();
    const wireFlags = wire?.options.map((o) => o.long) ?? [];
    expect(wireFlags).not.toContain('--provider');
    expect(wireFlags).not.toContain('--gitlab-token');
    expect(wireFlags).not.toContain('--github-token');

    const provider = program.commands.find((c) => c.name() === 'provider');
    expect(provider).toBeTruthy();
    const subs = provider?.commands.map((c) => c.name()) ?? [];
    expect(subs).toEqual(expect.arrayContaining(['add', 'refresh', 'remove']));
  });
});

describe('provider add/remove via runWire + runProviderRemove', () => {
  it('add registers the webhook and records provider metadata (assistants skipped)', { timeout: 15_000 }, async () => {
    const fetchImpl = mockGitLabFetch();
    const result = await runWire({
      repo: tmpRepo,
      home: tmpHome,
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl }),
      fetchImpl,
      installAssistants: [],
    });
    expect(result.providerResult?.webhookId).toBe(777);

    const wired = loadWiredRepos(tmpHome);
    const entry = Object.values(wired.wiredRepos)[0];
    expect(entry.providerId).toBe('gitlab');
    expect(entry.webhookId).toBe(777);
  });

  it('remove unregisters the webhook + clears provider metadata but keeps the repo wired', { timeout: 15_000 }, async () => {
    const addFetch = mockGitLabFetch();
    await runWire({
      repo: tmpRepo,
      home: tmpHome,
      provider: 'gitlab',
      gitlabBaseUrl: 'https://gitlab.example',
      gitlabToken: 'glpat-test',
      gitlabProjectPath: 'acme/repo',
      gitlabProvider: new GitLabProvider({ fetchImpl: addFetch }),
      fetchImpl: addFetch,
      installAssistants: [],
    });

    const removeFetch = mockGitLabFetch();
    const result = await runProviderRemove({
      repo: tmpRepo,
      home: tmpHome,
      gitlabProvider: new GitLabProvider({ fetchImpl: removeFetch }),
      fetchImpl: removeFetch,
    });
    expect(result.providerUnregistered).toBe(true);
    expect(result.providerMetadataCleared).toBe(true);
    expect(result.keychainCleaned).toBeGreaterThanOrEqual(1);

    const wired = loadWiredRepos(tmpHome);
    const entry = Object.values(wired.wiredRepos)[0];
    // Repo stays wired; provider fields gone.
    expect(entry).toBeTruthy();
    expect(entry.providerId).toBeUndefined();
    expect(entry.webhookId).toBeUndefined();
  });
});
