import { describe, it, expect } from 'vitest';
import { brainHookCommand, HOOK_VERBS, isHookVerb, parsePhase, parseAdapter } from '../hook-events.js';
import { HOOK_SENTINEL } from '../../types.js';

describe('brainHookCommand', () => {
  it('renders verb + adapter + sentinel for a phase-less verb', () => {
    const cmd = brainHookCommand({ verb: 'session-start', adapter: 'claude' });
    expect(cmd).toBe(`brain-hook session-start --adapter claude ${HOOK_SENTINEL}`);
  });

  it('renders verb + --phase + adapter + sentinel for a tool-use phase', () => {
    const cmd = brainHookCommand({ verb: 'tool-use', phase: 'pre', adapter: 'codex' });
    expect(cmd).toBe(`brain-hook tool-use --phase pre --adapter codex ${HOOK_SENTINEL}`);
  });

  it('preserves the cursor post-inject phase verbatim', () => {
    const cmd = brainHookCommand({ verb: 'tool-use', phase: 'post-inject', adapter: 'cursor' });
    expect(cmd).toContain('--phase post-inject');
    expect(cmd).toContain('--adapter cursor');
  });

  it('honors a custom bin override', () => {
    const cmd = brainHookCommand({ verb: 'stop', adapter: 'copilot', bin: '/abs/brain-hook' });
    expect(cmd.startsWith('/abs/brain-hook stop ')).toBe(true);
  });

  it('every verb renders a sentinel-suffixed command', () => {
    for (const verb of HOOK_VERBS) {
      const cmd = brainHookCommand({ verb, adapter: 'claude' });
      expect(cmd.endsWith(HOOK_SENTINEL)).toBe(true);
    }
  });
});

describe('hook-event guards', () => {
  it('isHookVerb accepts known verbs and rejects others', () => {
    expect(isHookVerb('tool-use')).toBe(true);
    expect(isHookVerb('nonsense')).toBe(false);
    expect(isHookVerb(undefined)).toBe(false);
  });

  it('parsePhase narrows known phases', () => {
    expect(parsePhase('post-inject')).toBe('post-inject');
    expect(parsePhase('weird')).toBeUndefined();
  });

  it('parseAdapter defaults to claude', () => {
    expect(parseAdapter('cursor')).toBe('cursor');
    expect(parseAdapter(undefined)).toBe('claude');
  });
});
