/**
 * PR6 §6.3 — `brain ownership` CLI namespace resolution.
 *
 * The CLI must send a `?namespace=` query param to `/api/query/ownership`
 * (the server now requires it for unbound tokens). This test exercises both
 * the resolver helper (manifest > credentials > default) and the runOwnership
 * call site (URL contains the resolved namespace).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveOwnershipNamespace } from '../commands/ownership-cmd.js';
import { runOwnership } from '../ownership.js';

const ORIG_ENV = { ...process.env };

let tmpHome: string;
let tmpRepo: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ownership-cmd-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ownership-cmd-repo-'));
  // Initialize a git repo so `git rev-parse --show-toplevel` works.
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
  execFileSync('git', ['config', 'user.email', 'test@x.test'], { cwd: tmpRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo });
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function writeManifest(repoRoot: string, namespace: string): void {
  const dir = path.join(repoRoot, '.second-brain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'team.json'),
    JSON.stringify({
      version: 1,
      namespace,
      server: { url: 'http://server.test' },
    }),
  );
}

function writeCredentials(homeDir: string, host: string, namespace: string): void {
  const dir = path.join(homeDir, '.second-brain', 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${host}.json`),
    JSON.stringify({
      serverUrl: `http://${host}`,
      namespace,
      userId: 'u1',
      email: 'me@x.test',
      defaultTokenId: 'tok1',
      redeemedAt: new Date().toISOString(),
    }),
  );
}

describe('resolveOwnershipNamespace', () => {
  it('uses the explicit flag value when provided', () => {
    const ns = resolveOwnershipNamespace({
      explicit: 'flag-ns',
      cwd: tmpRepo,
      homeDir: tmpHome,
    });
    expect(ns).toBe('flag-ns');
  });

  it('reads namespace from .second-brain/team.json when present', () => {
    writeManifest(tmpRepo, 'manifest-ns');
    const ns = resolveOwnershipNamespace({
      cwd: tmpRepo,
      homeDir: tmpHome,
    });
    expect(ns).toBe('manifest-ns');
  });

  it('falls back to credentials file when no manifest is present', () => {
    writeCredentials(tmpHome, 'server.test', 'creds-ns');
    const ns = resolveOwnershipNamespace({
      cwd: tmpRepo,
      homeDir: tmpHome,
      serverUrl: 'http://server.test',
    });
    expect(ns).toBe('creds-ns');
  });

  it('prefers manifest over credentials', () => {
    writeManifest(tmpRepo, 'manifest-ns');
    writeCredentials(tmpHome, 'server.test', 'creds-ns');
    const ns = resolveOwnershipNamespace({
      cwd: tmpRepo,
      homeDir: tmpHome,
      serverUrl: 'http://server.test',
    });
    expect(ns).toBe('manifest-ns');
  });

  it("falls back to 'personal' when nothing is configured", () => {
    const ns = resolveOwnershipNamespace({
      cwd: tmpRepo,
      homeDir: tmpHome,
    });
    expect(ns).toBe('personal');
  });

  it('throws on invalid-json manifest instead of silently defaulting to personal', () => {
    const dir = path.join(tmpRepo, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.json'), '{ this is not json');
    expect(() =>
      resolveOwnershipNamespace({
        cwd: tmpRepo,
        homeDir: tmpHome,
      }),
    ).toThrow(/invalid-json/);
  });

  it('throws on invalid-schema manifest instead of silently defaulting to personal', () => {
    const dir = path.join(tmpRepo, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'team.json'),
      JSON.stringify({ version: 1, namespace: '', server: { url: 'not-a-url' } }),
    );
    expect(() =>
      resolveOwnershipNamespace({
        cwd: tmpRepo,
        homeDir: tmpHome,
      }),
    ).toThrow(/invalid-schema/);
  });
});

describe('runOwnership — namespace param wiring', () => {
  it('sends ?namespace=<value> in the request URL', async () => {
    let capturedUrl: string | null = null;
    const fakeFetch = ((url: string | URL | Request, _init?: RequestInit) => {
      const u =
        typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      capturedUrl = u;
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

    await runOwnership({
      path: 'src/main.ts',
      namespace: 'team-from-manifest',
      json: true,
      serverUrl: 'http://server.test',
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).not.toBeNull();
    const parsed = new URL(capturedUrl!);
    expect(parsed.pathname).toBe('/api/query/ownership');
    expect(parsed.searchParams.get('path')).toBe('src/main.ts');
    expect(parsed.searchParams.get('namespace')).toBe('team-from-manifest');
  });
});
