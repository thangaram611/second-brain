import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  TeamManifestSchema,
  loadTeamManifest,
  hashTeamManifest,
  compileExtraDenyPatterns,
  teamManifestPath,
  type TeamManifest,
} from '../team-manifest.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-team-manifest-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const VALID_MANIFEST: TeamManifest = {
  version: 1,
  namespace: 'team-graph',
  server: { url: 'https://api.example.com', relayUrl: 'https://relay.example.com' },
  hooks: {
    git: ['post-commit', 'post-merge'],
    assistants: ['claude', 'cursor'],
    scope: 'user',
  },
  providers: {
    github: { owner: 'acme', repo: 'graph', webhookManagedBy: 'admin' },
  },
  client: { mode: 'local-only' },
  redact: { deny: ['SECRET_[A-Z0-9_]+', 'tok_[a-z0-9]{20,}'] },
};

function writeManifest(content: string | object): string {
  const dir = path.join(tmp, '.second-brain');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

describe('TeamManifestSchema', () => {
  it('round-trips a valid manifest with safeParse', () => {
    const result = TeamManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespace).toBe('team-graph');
      expect(result.data.hooks?.scope).toBe('user');
      expect(result.data.providers?.github?.webhookManagedBy).toBe('admin');
    }
  });

  it('rejects missing required fields', () => {
    const result = TeamManifestSchema.safeParse({ version: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid (non-http) URL', () => {
    const result = TeamManifestSchema.safeParse({
      version: 1,
      namespace: 'team',
      server: { url: 'ftp://example.com' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects version=2 (forward-incompat)', () => {
    const result = TeamManifestSchema.safeParse({
      ...VALID_MANIFEST,
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('applies defaults to optional sub-fields', () => {
    const result = TeamManifestSchema.safeParse({
      version: 1,
      namespace: 'team',
      server: { url: 'https://api.example.com' },
      hooks: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hooks?.git).toEqual([]);
      expect(result.data.hooks?.assistants).toEqual([]);
      expect(result.data.hooks?.scope).toBe('user');
    }
  });
});

describe('loadTeamManifest', () => {
  it('returns ok when the file exists and parses', () => {
    writeManifest(VALID_MANIFEST);
    const result = loadTeamManifest(tmp);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.namespace).toBe('team-graph');
      expect(result.absPath).toBe(teamManifestPath(tmp));
    }
  });

  it("returns reason='not-found' when the file is absent", () => {
    const result = loadTeamManifest(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
  });

  it("returns reason='invalid-json' on syntax errors", () => {
    writeManifest('{ this is not json');
    const result = loadTeamManifest(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-json');
      expect(result.detail).toBeTypeOf('string');
    }
  });

  it("returns reason='unreadable' when the file exists but read fails", () => {
    if (process.platform === 'win32') return;
    const dir = path.join(tmp, '.second-brain');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'team.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o000);
    try {
      // Skip if running as root — root can read anything regardless of mode.
      try {
        fs.readFileSync(file, 'utf8');
        return; // root, can read; skip
      } catch {
        /* expected — proceed */
      }
      const result = loadTeamManifest(tmp);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unreadable');
      }
    } finally {
      fs.chmodSync(file, 0o600); // so afterEach can rm
    }
  });

  it("returns reason='invalid-schema' with a prettified error", () => {
    writeManifest({ version: 1, namespace: '', server: { url: 'not-a-url' } });
    const result = loadTeamManifest(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-schema');
      expect(result.detail).toBeTypeOf('string');
      expect(result.detail!.length).toBeGreaterThan(0);
    }
  });
});

describe('hashTeamManifest', () => {
  it('is stable across equivalent inputs (key order independence)', () => {
    const a = hashTeamManifest(VALID_MANIFEST);
    const reordered: TeamManifest = {
      redact: VALID_MANIFEST.redact,
      client: VALID_MANIFEST.client,
      providers: VALID_MANIFEST.providers,
      hooks: VALID_MANIFEST.hooks,
      server: VALID_MANIFEST.server,
      namespace: VALID_MANIFEST.namespace,
      version: VALID_MANIFEST.version,
    };
    const b = hashTeamManifest(reordered);
    expect(a).toBe(b);
  });

  it('changes when content changes', () => {
    const a = hashTeamManifest(VALID_MANIFEST);
    const b = hashTeamManifest({ ...VALID_MANIFEST, namespace: 'different' });
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex SHA-256 digest', () => {
    const h = hashTeamManifest(VALID_MANIFEST);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('compileExtraDenyPatterns', () => {
  it('compiles valid regex strings', () => {
    const { patterns, errors } = compileExtraDenyPatterns(VALID_MANIFEST);
    expect(errors).toHaveLength(0);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].regex.test('SECRET_FOO=abc')).toBe(true);
    // gi flag: ensure the pattern matches case-insensitively.
    // regex is `tok_[a-z0-9]{20,}` — needs ≥20 chars after `tok_`. With the
    // `i` flag the `TOK_` prefix matches case-insensitively.
    expect(patterns[1].regex.test('TOK_abcdef01234567890abc')).toBe(true);
  });

  it('reports malformed regex strings without throwing', () => {
    const manifest: TeamManifest = {
      ...VALID_MANIFEST,
      redact: { deny: ['valid', '[unclosed'] },
    };
    const { patterns, errors } = compileExtraDenyPatterns(manifest);
    expect(patterns).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe('[unclosed');
  });

  it('returns empty when redact is absent', () => {
    const manifest: TeamManifest = { ...VALID_MANIFEST, redact: undefined };
    const { patterns, errors } = compileExtraDenyPatterns(manifest);
    expect(patterns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('does not corrupt non-matching input', () => {
    const { patterns } = compileExtraDenyPatterns(VALID_MANIFEST);
    const innocent = 'just a plain string with no secret';
    let mutated = innocent;
    for (const p of patterns) {
      mutated = mutated.replace(p.regex, '[REDACTED]');
    }
    expect(mutated).toBe(innocent);
  });
});
