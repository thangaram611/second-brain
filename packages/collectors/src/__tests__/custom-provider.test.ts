import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CustomProviderMappingSchema, type CustomProviderMapping } from '../providers/custom-provider-types.js';
import { CustomProvider } from '../providers/custom-provider.js';
import type { ProviderEvent } from '../providers/git-provider.js';

// ─── Template loading ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rawTemplate = JSON.parse(
  readFileSync(join(__dirname, '..', 'providers', 'templates', 'gitea.json'), 'utf-8'),
) as Record<string, unknown>;

const rawMappings = rawTemplate.mappings as Record<string, unknown>;

/** Gitea mapping parsed via Zod (only pull_request populated). */
const giteaMapping: CustomProviderMapping = CustomProviderMappingSchema.parse(rawTemplate);

/** Full mapping with review + comment keys re-keyed from the Gitea template. */
const fullMapping: CustomProviderMapping = CustomProviderMappingSchema.parse({
  ...rawTemplate,
  mappings: {
    pull_request: rawMappings.pull_request,
    review: rawMappings.pull_request_review,
    comment: rawMappings.pull_request_comment,
  },
});

/** Token-based verification variant of the Gitea mapping. */
const tokenMapping: CustomProviderMapping = CustomProviderMappingSchema.parse({
  ...rawTemplate,
  verification: { kind: 'token', header: 'x-gitea-token' },
  mappings: {
    pull_request: rawMappings.pull_request,
    review: rawMappings.pull_request_review,
    comment: rawMappings.pull_request_comment,
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────

const PROJECT = 'acme/repo';

function makeEvent(body: unknown, eventType: string, deliveryId = 'd1'): ProviderEvent {
  return {
    provider: 'custom',
    rawBody: body,
    rawHeaders: { 'x-gitea-event': eventType, 'x-gitea-delivery': deliveryId },
    receivedAt: '2026-04-15T00:00:00.000Z',
    deliveryId,
  };
}

function prPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'Add feature',
      body: 'description text',
      state: 'open',
      head: { ref: 'feat/x' },
      base: { ref: 'main' },
      user: { login: 'alice' },
      merged: false,
      merged_at: null,
      html_url: `https://gitea.example.com/${PROJECT}/pulls/42`,
      draft: false,
      ...overrides,
    },
    repository: { full_name: PROJECT },
  };
}

// ─── verifyDelivery — token mode ──────────────────────────────────────────

describe('CustomProvider.verifyDelivery — token mode', () => {
  const provider = new CustomProvider(tokenMapping);

  it('accepts a valid token', () => {
    const token = 'a'.repeat(64);
    const result = provider.verifyDelivery({
      request: { headers: { 'X-Gitea-Token': token }, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'token', value: token },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong token with reason mismatch', () => {
    const result = provider.verifyDelivery({
      request: { headers: { 'x-gitea-token': 'b'.repeat(64) }, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'token', value: 'a'.repeat(64) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('rejects a missing header with reason missing-header', () => {
    const result = provider.verifyDelivery({
      request: { headers: {}, rawBody: Buffer.from('') },
      expectedSecret: { kind: 'token', value: 'a'.repeat(64) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-header');
  });
});

// ─── verifyDelivery — hmac mode ───────────────────────────────────────────

describe('CustomProvider.verifyDelivery — hmac mode', () => {
  const provider = new CustomProvider(giteaMapping);

  it('accepts a valid HMAC signature', () => {
    const bodyBuf = Buffer.from('{"test":true}');
    const sig = createHmac('sha256', 'my-secret').update(bodyBuf).digest('hex');
    const result = provider.verifyDelivery({
      request: { headers: { 'x-gitea-signature': sig }, rawBody: bodyBuf },
      expectedSecret: { kind: 'hmac', key: 'my-secret' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an incorrect HMAC signature', () => {
    const bodyBuf = Buffer.from('{"test":true}');
    const wrongSig = createHmac('sha256', 'wrong-key').update(bodyBuf).digest('hex');
    const result = provider.verifyDelivery({
      request: { headers: { 'X-Gitea-Signature': wrongSig }, rawBody: bodyBuf },
      expectedSecret: { kind: 'hmac', key: 'correct-key' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });
});

// ─── mapEvent — pull_request ──────────────────────────────────────────────

describe('CustomProvider.mapEvent — pull_request', () => {
  const provider = new CustomProvider(fullMapping);

  it('maps opened to upsert-mr without flip', async () => {
    const obs = await provider.mapEvent(makeEvent(prPayload(), 'pull_request'));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('upsert-mr');
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip).toBeUndefined();
    expect(obs[0].entity.name).toBe(`${PROJECT}#42`);
    expect(obs[0].entity.properties?.iid).toBe(42);
    expect(obs[0].entity.properties?.sourceBranch).toBe('feat/x');
    expect(obs[0].entity.properties?.targetBranch).toBe('main');
    expect(obs[0].entity.properties?.title).toBe('Add feature');
    expect(obs[0].author.canonicalEmail).toBe('alice@noreply.gitea.example.com');
  });

  it('maps closed+merged to upsert-mr with flip.status=merged', async () => {
    const body = prPayload({
      merged: true,
      merged_at: '2026-04-13T12:00:00Z',
    });
    // Gitea sends action "closed" when a PR is merged-then-closed
    (body as Record<string, unknown>).action = 'closed';
    const obs = await provider.mapEvent(makeEvent(body, 'pull_request'));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip?.status).toBe('merged');
    expect(obs[0].flip?.mrIid).toBe(42);
    expect(obs[0].flip?.mergedAt).toBe('2026-04-13T12:00:00Z');
  });

  it('maps closed+unmerged to upsert-mr with flip.status=abandoned', async () => {
    const body = prPayload({ merged: false });
    (body as Record<string, unknown>).action = 'closed';
    const obs = await provider.mapEvent(makeEvent(body, 'pull_request'));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'upsert-mr') throw new Error('narrowing');
    expect(obs[0].flip?.status).toBe('abandoned');
  });
});

// ─── mapEvent — review ────────────────────────────────────────────────────

describe('CustomProvider.mapEvent — review', () => {
  const provider = new CustomProvider(fullMapping);

  it('maps approved review to state=approved', async () => {
    const body = {
      review: {
        type: 'approved',
        user: { login: 'bob' },
        submitted_at: '2026-04-13T10:00:00Z',
      },
      pull_request: { number: 42 },
      repository: { full_name: PROJECT },
    };
    const obs = await provider.mapEvent(makeEvent(body, 'review'));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('review');
    if (obs[0].kind !== 'review') throw new Error('narrowing');
    expect(obs[0].state).toBe('approved');
    expect(obs[0].mrRef).toEqual({ projectId: PROJECT, iid: 42 });
    expect(obs[0].author.canonicalEmail).toBe('bob@noreply.gitea.example.com');
  });

  it('maps changes-requested review to state=changes_requested', async () => {
    const body = {
      review: {
        type: 'rejected',
        user: { login: 'carol' },
        submitted_at: '2026-04-13T11:00:00Z',
      },
      pull_request: { number: 42 },
      repository: { full_name: PROJECT },
    };
    const obs = await provider.mapEvent(makeEvent(body, 'review'));
    expect(obs).toHaveLength(1);
    if (obs[0].kind !== 'review') throw new Error('narrowing');
    expect(obs[0].state).toBe('changes_requested');
  });
});

// ─── mapEvent — comment ───────────────────────────────────────────────────

describe('CustomProvider.mapEvent — comment', () => {
  const provider = new CustomProvider(fullMapping);

  it('maps a comment event to mr-comment', async () => {
    const body = {
      comment: {
        body: 'LGTM',
        id: 555,
        user: { login: 'charlie' },
        created_at: '2026-04-13T10:01:00Z',
      },
      pull_request: { number: 42 },
      repository: { full_name: PROJECT },
    };
    const obs = await provider.mapEvent(makeEvent(body, 'comment'));
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('mr-comment');
    if (obs[0].kind !== 'mr-comment') throw new Error('narrowing');
    expect(obs[0].body).toBe('LGTM');
    expect(obs[0].commentId).toBe(555);
    expect(obs[0].mrRef).toEqual({ projectId: PROJECT, iid: 42 });
    expect(obs[0].author.displayName).toBe('charlie');
    expect(obs[0].createdAt).toBe('2026-04-13T10:01:00Z');
  });
});

// ─── mapEvent — unknown event type ────────────────────────────────────────

describe('CustomProvider.mapEvent — unknown event type', () => {
  const provider = new CustomProvider(fullMapping);

  it('returns empty array for unrecognized event type', async () => {
    const obs = await provider.mapEvent(makeEvent({ data: 'irrelevant' }, 'wiki_page'));
    expect(obs).toEqual([]);
  });
});

// ─── No-op methods ────────────────────────────────────────────────────────

describe('CustomProvider no-op methods', () => {
  const provider = new CustomProvider(giteaMapping);

  it('auth returns placeholder identity', async () => {
    const res = await provider.auth({ baseUrl: 'https://gitea.example.com', pat: '' });
    expect(res.userId).toBe('custom');
    expect(res.username).toBe('gitea');
    expect(res.scopes).toEqual([]);
  });

  it('registerWebhook returns webhookId 0', async () => {
    const res = await provider.registerWebhook({
      provider: 'custom',
      projectId: 'acme/repo',
      relayUrl: 'https://smee.io/ch',
      secret: { kind: 'token', value: 'tok' },
    });
    expect(res.webhookId).toBe(0);
    expect(res.alreadyExisted).toBe(false);
  });

  it('unregisterWebhook resolves without error', async () => {
    await expect(
      provider.unregisterWebhook({ provider: 'custom', projectId: 'acme/repo', webhookId: 1 }),
    ).resolves.toBeUndefined();
  });

  it('pollEvents returns empty events and preserves cursor', async () => {
    const res = await provider.pollEvents({
      baseUrl: 'https://gitea.example.com',
      pat: '',
      projectId: 'acme/repo',
      since: '2026-04-13T00:00:00Z',
    });
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe('2026-04-13T00:00:00Z');
  });
});
