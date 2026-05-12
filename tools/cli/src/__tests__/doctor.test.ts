import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// The doctor's native-module ABI probe loads `better-sqlite3` via dynamic
// `import()`. Mock it once at the module level so every test gets a healthy
// stub by default — keeps the existing assertions independent of whatever
// ABI the host machine's prebuilt binary actually targets. The ABI-probe
// suite below overrides this with `vi.doMock` + `vi.resetModules()` to
// exercise the failure paths.
vi.mock('better-sqlite3', () => ({
  default: class FakeDatabase {
    constructor(_path: string) {
      /* no-op */
    }
    close(): void {
      /* no-op */
    }
  },
}));

import { runDoctor } from '../doctor.js';
import { writeCredentials } from '../credentials.js';
import { setKeychainTestOverride, resetKeychainCache } from '../keychain.js';

let homeOverride: string;
let repoRoot: string;
let stdoutBuf: string;
const sinkStdout = { write: (s: string): void => { stdoutBuf += s; } };

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-doctor-home-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-doctor-repo-'));
  stdoutBuf = '';
  process.env.HOME = homeOverride;
  delete process.env.BRAIN_AUTH_TOKEN;
  resetKeychainCache();
  // In-memory keychain stub.
  const store = new Map<string, string>();
  setKeychainTestOverride({
    setPassword: async (_s, a, p) => {
      store.set(a, p);
    },
    getPassword: async (_s, a) => store.get(a) ?? null,
    deletePassword: async (_s, a) => store.delete(a),
  });
});

afterEach(() => {
  fs.rmSync(homeOverride, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
  setKeychainTestOverride(null);
  resetKeychainCache();
});

function fakeFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(u);
  }) as unknown as typeof fetch;
}

describe('runDoctor — empty install', () => {
  it('returns warn for missing credentials but exitCode 0', async () => {
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    expect(result.exitCode).toBe(0);
    expect(result.checks.find((c) => c.name === 'credentials')!.status).toBe('warn');
  });
});

describe('runDoctor — with credentials + healthy server', () => {
  beforeEach(async () => {
    writeCredentials(
      'localhost:7430',
      {
        serverUrl: 'http://localhost:7430',
        namespace: 'team',
        userId: 'usr_1',
        email: 'a@b.test',
        defaultTokenId: 'aaaaaaaa',
        redeemedAt: new Date().toISOString(),
        patExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      homeOverride,
    );
    // Seed keychain with a PAT.
    const { storeSecret } = await import('../keychain.js');
    await storeSecret('pat:localhost:7430:aaaaaaaa', 'sbp_aaaaaaaa_AAAA');
  });

  it('all green when server returns 200 + matching userId', async () => {
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async (url) => {
        if (url.endsWith('/health')) return new Response('', { status: 200 });
        if (url.endsWith('/api/auth/whoami')) {
          return new Response(JSON.stringify({ userId: 'usr_1', mode: 'pat' }), { status: 200 });
        }
        return new Response('not-found', { status: 404 });
      }),
    });
    expect(result.exitCode).toBe(0);
    const reachable = result.checks.find((c) => c.name.startsWith('server reachable'));
    expect(reachable?.status).toBe('pass');
    const valid = result.checks.find((c) => c.name.startsWith('PAT valid'));
    expect(valid?.status).toBe('pass');
  });

  it('fails when server is unreachable', async () => {
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    expect(result.exitCode).toBe(1);
  });

  it('fails when whoami returns mismatched userId', async () => {
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async (url) => {
        if (url.endsWith('/health')) return new Response('', { status: 200 });
        if (url.endsWith('/api/auth/whoami')) {
          return new Response(JSON.stringify({ userId: 'usr_OTHER' }), { status: 200 });
        }
        return new Response('not-found', { status: 404 });
      }),
    });
    expect(result.exitCode).toBe(1);
  });

  it('warns on PAT expiring soon (<7d)', async () => {
    // Re-write credentials with a PAT expiring in 1 day.
    writeCredentials(
      'localhost:7430',
      {
        serverUrl: 'http://localhost:7430',
        namespace: 'team',
        userId: 'usr_1',
        email: 'a@b.test',
        defaultTokenId: 'aaaaaaaa',
        redeemedAt: new Date().toISOString(),
        patExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      homeOverride,
    );
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async (url) => {
        if (url.endsWith('/health')) return new Response('', { status: 200 });
        if (url.endsWith('/api/auth/whoami')) {
          return new Response(JSON.stringify({ userId: 'usr_1' }), { status: 200 });
        }
        return new Response('not-found', { status: 404 });
      }),
    });
    const expiry = result.checks.find((c) => c.name.startsWith('PAT expiry'));
    expect(expiry?.status).toBe('warn');
    expect(result.exitCode).toBe(0); // warn alone keeps exit code 0
  });

  it('fails on expired PAT', async () => {
    writeCredentials(
      'localhost:7430',
      {
        serverUrl: 'http://localhost:7430',
        namespace: 'team',
        userId: 'usr_1',
        email: 'a@b.test',
        defaultTokenId: 'aaaaaaaa',
        redeemedAt: new Date().toISOString(),
        patExpiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
      homeOverride,
    );
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('{}', { status: 200 })),
    });
    expect(result.exitCode).toBe(1);
  });
});

describe('runDoctor — adapter sidecar sentinel check', () => {
  it('fails when adapter sidecar missing the brain:v2 sentinel', async () => {
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    const cursorDir = path.join(repoRoot, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'hooks.json'),
      JSON.stringify({ hooks: { sessionStart: [{ command: 'brain-hook' }] } }),
    );
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    const sidecar = result.checks.find((c) => c.name.includes('cursor'));
    expect(sidecar?.status).toBe('fail');
    expect(result.exitCode).toBe(1);
  });

  it('passes when sentinel is present', async () => {
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    const cursorDir = path.join(repoRoot, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'hooks.json'),
      `{"hooks":{"sessionStart":[{"command":"brain-hook # brain:v2"}]}}`,
    );
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    const sidecar = result.checks.find((c) => c.name.includes('cursor'));
    expect(sidecar?.status).toBe('pass');
  });
});

describe('runDoctor — manifest drift', () => {
  it('records hash on first run, then warns on drift', async () => {
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.second-brain'), { recursive: true });
    const manifestPath = path.join(repoRoot, '.second-brain', 'team.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        namespace: 'team',
        server: { url: 'http://localhost:7430' },
      }),
    );
    // Pre-seed wired-repos so the manifest check finds the repo.
    const { saveWiredRepos, computeRepoHash } = await import('../git-context-daemon.js');
    saveWiredRepos({
      version: 1,
      wiredRepos: {
        [computeRepoHash(repoRoot)]: {
          repoHash: computeRepoHash(repoRoot),
          absPath: repoRoot,
          namespace: 'team',
          installedAt: new Date().toISOString(),
        },
      },
    });

    const first = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    expect(first.checks.find((c) => c.name.startsWith('team manifest'))?.status).toBe('pass');

    // Mutate manifest.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        namespace: 'team',
        server: { url: 'http://localhost:7431' }, // changed
      }),
    );
    const second = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    expect(second.checks.find((c) => c.name.startsWith('team manifest'))?.status).toBe('warn');
  });

  it('writes a versioned snapshot envelope (forward-compat schema)', async () => {
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.second-brain'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.second-brain', 'team.json'),
      JSON.stringify({
        version: 1,
        namespace: 'team',
        server: { url: 'http://localhost:7430' },
      }),
    );
    const { saveWiredRepos, computeRepoHash } = await import('../git-context-daemon.js');
    saveWiredRepos({
      version: 1,
      wiredRepos: {
        [computeRepoHash(repoRoot)]: {
          repoHash: computeRepoHash(repoRoot),
          absPath: repoRoot,
          namespace: 'team',
          installedAt: new Date().toISOString(),
        },
      },
    });

    await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });

    const snapshotPath = path.join(homeOverride, '.second-brain', '.manifest-snapshots.json');
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(raw.version).toBe(1);
    expect(typeof raw.hashes).toBe('object');
    expect(Object.keys(raw.hashes)).toHaveLength(1);
  });

  it('treats an invalid snapshot file as fresh (no crash, re-records)', async () => {
    // Pre-seed the snapshot file with an invalid shape.
    const snapshotPath = path.join(homeOverride, '.second-brain', '.manifest-snapshots.json');
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({ somehash: 'oldvalue' }));

    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.second-brain'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.second-brain', 'team.json'),
      JSON.stringify({
        version: 1,
        namespace: 'team',
        server: { url: 'http://localhost:7430' },
      }),
    );
    const { saveWiredRepos, computeRepoHash } = await import('../git-context-daemon.js');
    saveWiredRepos({
      version: 1,
      wiredRepos: {
        [computeRepoHash(repoRoot)]: {
          repoHash: computeRepoHash(repoRoot),
          absPath: repoRoot,
          namespace: 'team',
          installedAt: new Date().toISOString(),
        },
      },
    });

    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    // Invalid entries are ignored; the current schema replaces them.
    const m = result.checks.find((c) => c.name.startsWith('team manifest'));
    expect(m?.status).toBe('pass');
    const written = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.hashes).toBeDefined();
  });
});

describe('runDoctor — native module ABI probe', () => {
  // The probes load `better-sqlite3` via dynamic `import()`. To keep these
  // tests independent of whatever Node ABI the host's prebuilt binary
  // targets, every case uses `vi.doMock('better-sqlite3', ...)` to inject a
  // deterministic factory before re-importing the doctor module.
  afterEach(() => {
    vi.doUnmock('better-sqlite3');
    vi.resetModules();
  });

  it('passes when better-sqlite3 mock loads + opens an in-memory DB', async () => {
    // Uses the module-level `vi.mock('better-sqlite3')` stub.
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    const probe = result.checks.find((c) => c.name === 'native module ABI (better-sqlite3)');
    expect(probe?.status).toBe('pass');
  });

  it('emits the rebuild hint on a NODE_MODULE_VERSION mismatch', async () => {
    // Real ABI mismatch throws on `require(...)` of the .node file, which
    // surfaces during `new Database(...)` because better-sqlite3 lazy-loads
    // its native binding via `bindings()` in the Database constructor.
    // Simulate that: import succeeds, construction throws. Avoids cascading
    // failure into unrelated workspace packages that also import the module.
    vi.resetModules();
    vi.doMock('better-sqlite3', () => ({
      default: class FakeDatabase {
        constructor(_path: string) {
          throw new Error(
            "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
              'was compiled against a different Node.js version using NODE_MODULE_VERSION 141. ' +
              'This version of Node.js requires NODE_MODULE_VERSION 127.',
          );
        }
        close(): void {
          /* unreachable */
        }
      },
    }));
    const { runDoctor: freshRunDoctor } = await import('../doctor.js');
    const result = await freshRunDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    const probe = result.checks.find((c) => c.name === 'native module ABI (better-sqlite3)');
    expect(probe?.status).toBe('fail');
    expect(probe?.message).toContain('NODE_MODULE_VERSION mismatch');
    expect(probe?.message).toContain('pnpm rebuild-native');
    expect(result.exitCode).toBe(1);
    expect(stdoutBuf).toContain('pnpm rebuild-native');
  });

  it('emits a generic load failure when better-sqlite3 throws an unrelated error', async () => {
    vi.resetModules();
    vi.doMock('better-sqlite3', () => ({
      default: class FakeDatabase {
        constructor(_path: string) {
          throw new Error('libsqlite3.so: cannot open shared object file');
        }
        close(): void {
          /* unreachable */
        }
      },
    }));
    const { runDoctor: freshRunDoctor } = await import('../doctor.js');
    const result = await freshRunDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    const probe = result.checks.find((c) => c.name === 'native module load (better-sqlite3)');
    expect(probe?.status).toBe('fail');
    expect(probe?.message).toContain('libsqlite3.so');
    expect(result.exitCode).toBe(1);
  });
});

describe('runDoctor — local server checks (top-level, server.json-gated)', () => {
  function seedServerConfig(opts: { apiPort: number; relayPort: number }): void {
    const dir = path.join(homeOverride, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'server.json'),
      JSON.stringify({
        apiPort: opts.apiPort,
        relayPort: opts.relayPort,
        publicUrl: `http://localhost:${opts.apiPort}`,
        storageDir: path.join(homeOverride, '.second-brain', 'data'),
        secretsPath: path.join(homeOverride, '.second-brain', 'secrets.env'),
        serviceFilePath: null,
        relayServiceFilePath: null,
      }),
    );
  }

  it('skips both local checks when server.json is absent (client-only box)', async () => {
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    expect(result.checks.find((c) => c.name === 'local server reachable')).toBeUndefined();
    expect(result.checks.find((c) => c.name === 'local relay reachable')).toBeUndefined();
  });

  it('passes local-server when /health on apiPort returns 200 + {status:ok}', async () => {
    seedServerConfig({ apiPort: 7430, relayPort: 9421 });
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async (url) => {
        if (url === 'http://localhost:7430/health') {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url === 'http://localhost:9421/health') {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        return new Response('not-found', { status: 404 });
      }),
    });
    const server = result.checks.find((c) => c.name === 'local server reachable');
    expect(server?.status).toBe('pass');
    expect(server?.message).toContain('7430');
    const relay = result.checks.find((c) => c.name === 'local relay reachable');
    expect(relay?.status).toBe('pass');
    expect(relay?.message).toContain('9421');
  });

  it('fails local-relay on ECONNREFUSED with a load-hint', async () => {
    seedServerConfig({ apiPort: 7430, relayPort: 9421 });
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async (url) => {
        if (url === 'http://localhost:7430/health') {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        // Relay port: connection refused.
        throw new Error('ECONNREFUSED');
      }),
    });
    const relay = result.checks.find((c) => c.name === 'local relay reachable');
    expect(relay?.status).toBe('fail');
    expect(relay?.message).toMatch(/load relay plist\/unit/);
    expect(result.exitCode).toBe(1);
  });

  it('reports unreadable server.json as a single fail check, does not crash', async () => {
    const dir = path.join(homeOverride, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.json'), '{ "broken');
    const result = await runDoctor({
      homeDir: homeOverride,
      cwd: repoRoot,
      stdout: sinkStdout,
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    });
    const cfgCheck = result.checks.find((c) => c.name === 'local server config');
    expect(cfgCheck?.status).toBe('fail');
    expect(cfgCheck?.message).toContain('unreadable');
    expect(cfgCheck?.message).toContain('brain init server --force');
    // Local-server / local-relay checks must NOT appear when config is unreadable.
    expect(result.checks.find((c) => c.name === 'local server reachable')).toBeUndefined();
    expect(result.checks.find((c) => c.name === 'local relay reachable')).toBeUndefined();
  });
});

describe('runDoctor — unreadable manifest', () => {
  it('reports a fail (not a clean solo-repo pass) when the manifest file is unreadable', async () => {
    if (process.platform === 'win32') return;
    const dir = path.join(repoRoot, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'team.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o000);
    try {
      try {
        fs.readFileSync(file, 'utf8');
        return; // root, skip
      } catch {
        /* expected — proceed */
      }
      const result = await runDoctor({
        homeDir: homeOverride,
        cwd: repoRoot,
        stdout: sinkStdout,
        fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
      });
      const m = result.checks.find((c) => c.name.startsWith('team manifest'));
      expect(m?.status).toBe('fail');
      expect(result.exitCode).toBe(1);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});
