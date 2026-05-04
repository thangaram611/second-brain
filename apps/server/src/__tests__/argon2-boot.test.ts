/**
 * Boot-time refuse-to-start guard for Argon2id env config.
 *
 * The point of this file (vs the env tests in users.test.ts) is to prove the
 * guard fires at *construction* — not on the first mint call — so a bad env
 * config can never reach `server.listen()`. We deliberately do NOT call
 * `getArgon2Options()` here: that would mask a regression where the policy
 * lives only in the option getter (which would only fire on first mint).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('argon2 boot guard — fires at UsersService construction', () => {
  it('throws when env params fall below both OWASP baselines', async () => {
    vi.stubEnv('BRAIN_ARGON2_M', '1024');
    vi.stubEnv('BRAIN_ARGON2_T', '1');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    // Re-import so module-level reads (and the constructor) run with the
    // stubbed env in effect.
    vi.resetModules();
    const { UsersService } = await import('../services/users.js');
    expect(() => new UsersService({ path: ':memory:' })).toThrow(
      /below both OWASP baselines/,
    );
    expect(() => new UsersService({ path: ':memory:' })).toThrow(
      /BRAIN_ARGON2_M=1024/,
    );
  });

  it('throws when env values are malformed (non-positive integer)', async () => {
    vi.stubEnv('BRAIN_ARGON2_M', 'not-a-number');
    vi.resetModules();
    const { UsersService } = await import('../services/users.js');
    expect(() => new UsersService({ path: ':memory:' })).toThrow(
      /Invalid BRAIN_ARGON2_M/,
    );
  });

  it('constructs cleanly at the small-VPS baseline (m=19456, t=2, p=1)', async () => {
    vi.stubEnv('BRAIN_ARGON2_M', '19456');
    vi.stubEnv('BRAIN_ARGON2_T', '2');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    vi.resetModules();
    const { UsersService } = await import('../services/users.js');
    const svc = new UsersService({ path: ':memory:' });
    expect(svc).toBeDefined();
    svc.close();
  });

  it('constructs cleanly with no env vars set (defaults pass the policy)', async () => {
    vi.stubEnv('BRAIN_ARGON2_M', '');
    vi.stubEnv('BRAIN_ARGON2_T', '');
    vi.stubEnv('BRAIN_ARGON2_P', '');
    vi.resetModules();
    const { UsersService } = await import('../services/users.js');
    const svc = new UsersService({ path: ':memory:' });
    expect(svc).toBeDefined();
    svc.close();
  });

  it('exports `assertArgon2ParamsMeetOwasp` so callers can fail even earlier', async () => {
    vi.stubEnv('BRAIN_ARGON2_M', '1024');
    vi.stubEnv('BRAIN_ARGON2_T', '1');
    vi.stubEnv('BRAIN_ARGON2_P', '1');
    vi.resetModules();
    const { assertArgon2ParamsMeetOwasp } = await import('../services/users.js');
    expect(() => assertArgon2ParamsMeetOwasp()).toThrow(/below both OWASP baselines/);
  });
});
