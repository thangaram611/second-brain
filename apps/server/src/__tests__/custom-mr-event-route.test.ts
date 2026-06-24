import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { Brain } from '@second-brain/core';
import {
  CustomProvider,
  CustomProviderMappingSchema,
  type WebhookSecret,
  type GitProvider,
} from '@second-brain/collectors';
import { createApp } from '../app.js';
import { ObservationService } from '../services/observation-service.js';
import { PromotionService } from '../services/promotion-service.js';
import type { Express } from 'express';

const PROJECT_ID = 'acme/forge-repo';
const PROVIDER_KEY = `custom:${PROJECT_ID}`;
const HMAC_SECRET = 'b'.repeat(64);

// Load the shipped gitea template so the test exercises a realistic mapping.
const collectorsProvidersDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'collectors',
  'src',
  'providers',
  'templates',
);
const giteaRaw: unknown = JSON.parse(
  readFileSync(join(collectorsProvidersDir, 'gitea.json'), 'utf-8'),
);
const giteaMapping = CustomProviderMappingSchema.parse(giteaRaw);

let brain: Brain;
let app: Express;
let observations: ObservationService;

beforeEach(() => {
  brain = new Brain({ path: ':memory:', wal: false });
  const promotion = new PromotionService(brain, null);
  observations = new ObservationService(brain, promotion);
  observations.mrEvents.registerWiredProject('custom', PROJECT_ID, 'forge');
  const webhookSecrets = new Map<string, WebhookSecret>([
    [PROVIDER_KEY, { kind: 'hmac', key: HMAC_SECRET }],
  ]);
  const providerRegistry = new Map<string, GitProvider>([
    ['custom', new CustomProvider(giteaMapping)],
  ]);
  app = createApp(brain, {
    observations,
    observeOptions: { webhookSecrets, providerRegistry },
  });
});

afterEach(() => {
  brain.close();
});

function openPrPayload(): unknown {
  return {
    action: 'opened',
    pull_request: {
      number: 7,
      title: 'Custom forge PR',
      body: 'from gitea',
      state: 'open',
      head: { ref: 'feat/forge' },
      base: { ref: 'main' },
      user: { login: 'carol' },
      merged: false,
      merged_at: '',
      html_url: 'https://forge.example.com/acme/forge-repo/pulls/7',
      draft: false,
    },
    repository: { full_name: PROJECT_ID },
  };
}

function post(deliveryId: string, raw: unknown, signatureOverride?: string) {
  const rawBody = JSON.stringify(raw);
  const signature =
    signatureOverride ??
    createHmac('sha256', HMAC_SECRET).update(Buffer.from(rawBody, 'utf8')).digest('hex');
  return request(app)
    .post('/api/observe/mr-event')
    .send({
      provider: 'custom',
      projectId: PROJECT_ID,
      deliveryId,
      rawEvent: raw,
      rawBody,
      rawHeaders: {
        'content-type': 'application/json',
        'x-gitea-event': 'pull_request',
        'x-gitea-signature': signature,
      },
    });
}

describe('POST /api/observe/mr-event — provider:custom', () => {
  it('valid custom webhook is accepted and upserts a merge_request', async () => {
    const res = await post('c1', openPrPayload()).expect(201);
    expect(res.body.actions).toBeGreaterThan(0);
    expect(res.body.namespace).toBe('forge');

    const mrs = brain.entities.findByTypeAndProperty('merge_request', '$.iid', 7, 'forge');
    expect(mrs).toHaveLength(1);
    expect(mrs[0].properties.title).toBe('Custom forge PR');

    // authored_by person resolved via the noreply template.
    const persons = brain.entities.findByTypeAndProperty(
      'person',
      '$.canonicalEmail',
      'carol@noreply.gitea.example.com',
      'forge',
    );
    expect(persons).toHaveLength(1);
  });

  it('bad HMAC signature returns 401', async () => {
    await post('c-bad', openPrPayload(), 'deadbeef').expect(401);
  });

  it('missing signature header returns 401', async () => {
    const res = await request(app)
      .post('/api/observe/mr-event')
      .send({
        provider: 'custom',
        projectId: PROJECT_ID,
        deliveryId: 'c-missing',
        rawEvent: openPrPayload(),
        rawBody: JSON.stringify(openPrPayload()),
        rawHeaders: { 'content-type': 'application/json', 'x-gitea-event': 'pull_request' },
      });
    expect(res.status).toBe(401);
  });
});
