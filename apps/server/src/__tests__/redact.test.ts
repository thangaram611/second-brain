import { describe, it, expect } from 'vitest';
import { redactString, redactValue } from '../middleware/redact.js';

describe('built-in denylist regex bank', () => {
  const cases: Array<{ name: string; input: string; mustNotContain: string }> = [
    { name: 'AWS access key id', input: 'export AKIAABCDEFGHIJKLMNOP', mustNotContain: 'AKIAABCDEFGHIJKLMNOP' },
    { name: 'AWS env', input: 'AWS_SECRET_ACCESS_KEY=abc/def+ghi', mustNotContain: 'abc/def+ghi' },
    { name: 'GitHub PAT', input: 'token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mustNotContain: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'GitHub OAuth', input: 'GH_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', mustNotContain: 'ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    { name: 'GitLab PAT', input: 'creds: glpat-aaaaaaaaaaaaaaaaaaaa', mustNotContain: 'glpat-aaaaaaaaaaaaaaaaaaaa' },
    { name: 'OpenAI API key', input: 'OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaa', mustNotContain: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'Anthropic API key', input: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa', mustNotContain: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'Slack token', input: 'xoxb-aaaaaaaaaaaaaaaaaaaaaa', mustNotContain: 'xoxb-aaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'Google API key', input: 'AIzaABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', mustNotContain: 'AIzaABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' },
    { name: 'Google OAuth', input: 'ya29.aaaaaaaaaaaaaaaaaaaaaa', mustNotContain: 'ya29.aaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'npm token', input: 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mustNotContain: 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    {
      name: 'PEM private key',
      input:
        '-----BEGIN RSA PRIVATE KEY-----\nABC123def456==\nMORE_LINES_HERE\n-----END RSA PRIVATE KEY-----',
      mustNotContain: 'ABC123def456',
    },
    { name: 'Generic api_key', input: 'api_key: super-secret-value', mustNotContain: 'super-secret-value' },
    { name: 'Generic password', input: 'password=hunter2', mustNotContain: 'hunter2' },
    { name: 'Generic env-style secret', input: 'CUSTOM_SERVICE_KEY=abcdefg', mustNotContain: 'abcdefg' },
  ];

  for (const c of cases) {
    it(`redacts ${c.name}`, () => {
      const out = redactString(c.input);
      expect(out.redacted).not.toContain(c.mustNotContain);
      expect(out.count).toBeGreaterThan(0);
    });
  }

  it('does not redact innocuous text', () => {
    const out = redactString('This is a totally normal sentence about cats and dogs.');
    expect(out.redacted).toBe('This is a totally normal sentence about cats and dogs.');
    expect(out.count).toBe(0);
  });

  it('strips <private> blocks', () => {
    const out = redactString('Public stuff <private>db_pass=hunter2</private> visible.');
    expect(out.redacted).not.toContain('hunter2');
    expect(out.redacted).toContain('Public stuff');
    expect(out.count).toBeGreaterThan(0);
  });
});

describe('redactValue (recursive)', () => {
  it('walks objects and arrays', () => {
    const input = {
      env: { OPENAI_API_KEY: 'sk-aaaaaaaaaaaaaaaaaaaa' },
      args: ['curl', '-H', 'Authorization: Bearer abcdef123456'],
      message: 'all good',
    };
    const out = redactValue(input);
    const stringified = JSON.stringify(out.value);
    expect(stringified).not.toContain('sk-aaaaaaaaaaaaaaaaaaaa');
    expect(stringified).not.toContain('Bearer abcdef123456');
    expect(out.count).toBeGreaterThan(0);
  });

  it('preserves non-string scalars', () => {
    const out = redactValue({ count: 42, ok: true, none: null });
    expect(out.value).toEqual({ count: 42, ok: true, none: null });
    expect(out.count).toBe(0);
  });
});

describe('admin extra patterns', () => {
  it('applies caller-provided regexes', () => {
    const out = redactString('JIRA_API_TOKEN=topsecret', [/JIRA_API_TOKEN=\S+/g]);
    expect(out.redacted).not.toContain('topsecret');
    expect(out.count).toBe(1);
  });
});
