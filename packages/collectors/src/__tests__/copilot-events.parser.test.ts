import { describe, it, expect } from 'vitest';
import { mapCopilotEnvelope } from '../realtime/parsers/copilot-events.js';

describe('mapCopilotEnvelope', () => {
  it('maps session.start to session-start observation', () => {
    const obs = mapCopilotEnvelope('s1', {
      type: 'session.start',
      data: { cwd: '/repo', branch: 'main' },
    });
    expect(obs?.kind).toBe('session-start');
    if (obs?.kind === 'session-start') {
      expect(obs.payload.cwd).toBe('/repo');
      expect(obs.payload.branch).toBe('main');
    }
  });

  it('prefers transformedContent over content for user.message', () => {
    const obs = mapCopilotEnvelope('s2', {
      type: 'user.message',
      data: { content: 'raw', transformedContent: 'transformed' },
    });
    expect(obs?.kind).toBe('prompt');
    if (obs?.kind === 'prompt') expect(obs.prompt).toBe('transformed');
  });

  it('returns null for purely-structural events (turn_start/turn_end)', () => {
    expect(mapCopilotEnvelope('s3', { type: 'assistant.turn_start' })).toBeNull();
    expect(mapCopilotEnvelope('s3', { type: 'assistant.turn_end' })).toBeNull();
  });

  it('passes through unknown event types as `other` so we never drop Copilot upgrades', () => {
    const obs = mapCopilotEnvelope('s4', {
      type: 'something.new',
      data: { foo: 'bar' },
    });
    expect(obs?.kind).toBe('other');
    if (obs?.kind === 'other') {
      expect(obs.type).toBe('something.new');
      expect(obs.rawPayload).toEqual({ foo: 'bar' });
    }
  });

  it('handles session.end', () => {
    const obs = mapCopilotEnvelope('s5', { type: 'session.end' });
    expect(obs?.kind).toBe('session-end');
  });
});
