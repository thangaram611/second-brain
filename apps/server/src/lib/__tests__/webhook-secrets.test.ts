import { describe, expect, it } from 'vitest';
import { loadWebhookSecretsFromEnv } from '../webhook-secrets.js';

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

describe('loadWebhookSecretsFromEnv', () => {
  it('loads shell-safe hex-encoded GitHub HMAC env vars', () => {
    const secrets = loadWebhookSecretsFromEnv({
      [`SECOND_BRAIN_WEBHOOK_HMAC_HEX__github__${hex('acme/repo-with-dash')}`]: 'hmac-secret',
    });

    expect(secrets.get('github:acme/repo-with-dash')).toEqual({
      kind: 'hmac',
      key: 'hmac-secret',
    });
  });

  it('loads shell-safe hex-encoded GitLab token env vars', () => {
    const secrets = loadWebhookSecretsFromEnv({
      [`SECOND_BRAIN_WEBHOOK_SECRET_HEX__gitlab__${hex('123')}`]: 'token-secret',
    });

    expect(secrets.get('gitlab:123')).toEqual({
      kind: 'token',
      value: 'token-secret',
    });
  });

  it('keeps the previous direct project-id env form for simple project IDs', () => {
    const secrets = loadWebhookSecretsFromEnv({
      SECOND_BRAIN_WEBHOOK_SECRET__gitlab__123: 'token-secret',
      SECOND_BRAIN_WEBHOOK_HMAC__github__acme_repo: 'hmac-secret',
    });

    expect(secrets.get('gitlab:123')).toEqual({ kind: 'token', value: 'token-secret' });
    expect(secrets.get('github:acme_repo')).toEqual({ kind: 'hmac', key: 'hmac-secret' });
  });
});
