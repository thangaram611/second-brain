import { describe, it, expect } from 'vitest';
import {
  redactString,
  redactValue,
  redactRequestBody,
  isEnvFilePath,
  redactHome,
  _builtinPatternsCount,
} from '../lib/redact.js';

describe('redactString — built-in deny bank', () => {
  it('redacts AWS keys', () => {
    expect(redactString('AWS_SECRET_ACCESS_KEY=abc123xyz')).toBe('[REDACTED]');
    expect(redactString('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
    expect(redactString('plain AKIAIOSFODNN7EXAMPLE token')).toContain('[REDACTED]');
  });

  it('redacts GitHub PAT shapes', () => {
    expect(redactString('GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe('[REDACTED]');
    expect(redactString('My token is ghp_abcdefghijklmnopqrstuvwxyz1234567890.')).toContain('[REDACTED]');
    expect(redactString('ghs_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]');
  });

  it('redacts GitLab PATs', () => {
    expect(redactString('use glpat-abcdefghijklmnopqrst here')).toContain('[REDACTED]');
    expect(redactString('GITLAB_TOKEN=glpat-1234567890abcdefghij')).toBe('[REDACTED]');
  });

  it('redacts OpenAI sk- (and not sk-ant-)', () => {
    const out = redactString('OPENAI_API_KEY=sk-A1B2C3D4E5F6G7H8I9J0K');
    expect(out).toBe('[REDACTED]');
    const ant = redactString('ANTHROPIC_API_KEY=sk-ant-1234567890abcdefghij');
    expect(ant).toBe('[REDACTED]');
    // Bare sk- (no sk-ant-) also redacted.
    const bare = redactString('use sk-A1B2C3D4E5F6G7H8I9J0K1L2M now');
    expect(bare).toContain('[REDACTED]');
  });

  it('redacts Anthropic sk-ant- in raw form', () => {
    expect(redactString('Authorization sk-ant-abcdefghijklmnopqrst is mine'))
      .toContain('[REDACTED]');
  });

  it('redacts Slack tokens', () => {
    expect(redactString('xoxb-1234567890-abcdef')).toContain('[REDACTED]');
    expect(redactString('xoxp-fed-cba-9876543210')).toContain('[REDACTED]');
  });

  it('redacts Google API keys + OAuth', () => {
    expect(redactString('AIzaSyAbcdefghijklmnopqrstuvwxyz123456789'))
      .toContain('[REDACTED]');
    expect(redactString('ya29.abcdefghijklmnopqrstuvwxyz0123'))
      .toContain('[REDACTED]');
  });

  it('redacts npm tokens', () => {
    expect(redactString('npm_AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKL'))
      .toContain('[REDACTED]');
  });

  it('redacts PEM private key bodies', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redactString(`prefix\n${pem}\nsuffix`)).toContain('[REDACTED]');
    expect(redactString(`prefix\n${pem}\nsuffix`)).not.toContain('MIIEpAI');
  });

  it('redacts generic key=value secret-shape', () => {
    expect(redactString('api_key=hunter2 here')).toContain('[REDACTED]');
    expect(redactString('bearer: abc.def.ghi')).toContain('[REDACTED]');
    expect(redactString('password = correct-horse-battery-staple')).toContain('[REDACTED]');
  });

  it('redacts all-caps SOMETHING_TOKEN= shape', () => {
    expect(redactString('JIRA_API_TOKEN=jt_xyz')).toContain('[REDACTED]');
    expect(redactString('STRIPE_SECRET=sk_live_abc')).toContain('[REDACTED]');
  });

  it('non-secret strings pass through unchanged', () => {
    const safe = 'normal log line about /repo/src/auth.ts';
    expect(redactString(safe)).toBe(safe);
  });

  it('ships > 10 built-in patterns', () => {
    expect(_builtinPatternsCount()).toBeGreaterThan(10);
  });

  it('extra deny patterns are honored', () => {
    const out = redactString('XYZ_INTERNAL=topsecret', {
      extraDeny: [/XYZ_INTERNAL=\S+/g],
    });
    expect(out).toBe('[REDACTED]');
  });
});

describe('redactHome', () => {
  it('replaces a literal home prefix with ~', () => {
    expect(redactHome('/Users/jane/docs', '/Users/jane')).toBe('~/docs');
  });
  it('replaces every occurrence', () => {
    expect(redactHome('/Users/jane and /Users/jane/code', '/Users/jane'))
      .toBe('~ and ~/code');
  });
});

describe('isEnvFilePath', () => {
  it('matches .env families', () => {
    expect(isEnvFilePath('.env')).toBe(true);
    expect(isEnvFilePath('/repo/.env')).toBe(true);
    expect(isEnvFilePath('/repo/.env.local')).toBe(true);
    expect(isEnvFilePath('app/.env.production.local')).toBe(true);
  });
  it('does not match other dotfiles or non-env paths', () => {
    expect(isEnvFilePath('.envoy')).toBe(false);
    expect(isEnvFilePath('environment.ts')).toBe(false);
    expect(isEnvFilePath('/repo/src/auth.ts')).toBe(false);
  });
});

describe('redactValue — recursion + .env short-circuit', () => {
  it('walks arrays and objects', () => {
    const v = redactValue({
      a: 'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      b: ['safe', 'AWS_SECRET_ACCESS_KEY=aaa'],
    });
    expect(JSON.stringify(v)).not.toContain('ghp_');
    expect(JSON.stringify(v)).not.toContain('AWS_SECRET_ACCESS_KEY=aaa');
  });

  it('short-circuits .env content fields', () => {
    const v = redactValue({
      file_path: '/repo/.env.production',
      content: 'STRIPE_KEY=plaintext\nPORT=3000',
    });
    expect(v && typeof v === 'object' && !Array.isArray(v)).toBe(true);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v);
      const contentEntry = entries.find(([k]) => k === 'content');
      expect(contentEntry?.[1]).toBe('[REDACTED]');
    }
  });

  it('preserves null / numeric / boolean primitives', () => {
    expect(redactValue(null)).toBe(null);
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
  });
});

describe('redactRequestBody', () => {
  it('replaces home dir with ~', () => {
    const body = redactRequestBody({ cwd: '/Users/jane/repo' }, { homeDir: '/Users/jane' });
    expect(body.cwd).toBe('~/repo');
  });

  it('returns a new object (no mutation)', () => {
    const input = { foo: 'AWS_SECRET_ACCESS_KEY=xyz' };
    const out = redactRequestBody(input);
    expect(input.foo).toBe('AWS_SECRET_ACCESS_KEY=xyz');
    expect(out.foo).toBe('[REDACTED]');
  });
});
