import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth-store.js';
import { api } from '../lib/api.js';

/**
 * These tests verify the request() helper in apps/ui/src/lib/api.ts:
 *   - sends `credentials: 'include'` on every fetch
 *   - sends `X-CSRF-Token` on non-GET requests when an auth-store CSRF token is present
 *   - on 401 in 'pat' mode, navigates to /login (HashRouter convention)
 *   - on 401 in 'open' or 'unknown' mode, surfaces the error to the caller
 *   - login() success populates auth-store; login() 401 surfaces the error
 *   - bootstrap() in 'open' mode (whoami returns no csrfToken) does NOT redirect
 *
 * We mock global fetch and inspect the call arguments. To avoid `as` casts
 * (project rule), we type the spy as a Mock<typeof fetch>.
 */

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const initialAuthState = {
  csrfToken: null,
  user: null,
  mode: 'unknown' as const,
  relayUrl: null,
  bootstrapped: false,
  loading: false,
  error: null,
};

function mockFetchOnce(spy: FetchMock, status: number, body: unknown): void {
  // 204 No Content disallows any body per the Fetch spec; pass null body.
  const init: ResponseInit = {
    status,
    headers: { 'Content-Type': 'application/json' },
  };
  const responseBody =
    status === 204 || body === '' ? null : typeof body === 'string' ? body : JSON.stringify(body);
  spy.mockResolvedValueOnce(new Response(responseBody, init));
}

/** Pull the (url, init) pair from a fetch-mock call without type casts. */
function callOf(spy: FetchMock, idx: number): { url: string; init: RequestInit } {
  const call = spy.mock.calls[idx];
  if (!call) throw new Error(`fetch was not called at index ${idx}`);
  const [first, second] = call;
  if (typeof first !== 'string') throw new Error('expected string URL in fetch call');
  return { url: first, init: second ?? {} };
}

function headersOf(spy: FetchMock, idx: number): Headers {
  return new Headers(callOf(spy, idx).init.headers);
}

describe('api request() helper — auth integration', () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    useAuthStore.setState(initialAuthState);

    // vitest's default node test env provides a `window` shim. If it's not
    // present, stub one with just the bits the auth code touches.
    if (typeof window === 'undefined') {
      vi.stubGlobal('window', { location: { hash: '', pathname: '/' } });
    } else {
      window.location.hash = '';
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends credentials: include on every request', async () => {
    mockFetchOnce(fetchSpy, 200, []);
    await api.entities.list();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(callOf(fetchSpy, 0).init.credentials).toBe('include');
  });

  it('does NOT send X-CSRF-Token on GET requests even when csrfToken is set', async () => {
    useAuthStore.setState({ ...initialAuthState, csrfToken: 'csrf-abc', mode: 'pat' });
    mockFetchOnce(fetchSpy, 200, []);
    await api.entities.list();
    expect(headersOf(fetchSpy, 0).has('X-CSRF-Token')).toBe(false);
  });

  it('sends X-CSRF-Token on POST requests when csrfToken is present', async () => {
    useAuthStore.setState({ ...initialAuthState, csrfToken: 'csrf-xyz', mode: 'pat' });
    mockFetchOnce(fetchSpy, 200, { id: 'e1' });
    await api.entities.create({ type: 'concept', name: 'Test' });
    const headers = headersOf(fetchSpy, 0);
    expect(headers.get('X-CSRF-Token')).toBe('csrf-xyz');
    expect(callOf(fetchSpy, 0).init.method).toBe('POST');
  });

  it('sends X-CSRF-Token on DELETE and PATCH', async () => {
    useAuthStore.setState({ ...initialAuthState, csrfToken: 'csrf-d', mode: 'pat' });

    mockFetchOnce(fetchSpy, 204, '');
    await api.entities.delete('e1');
    expect(headersOf(fetchSpy, 0).get('X-CSRF-Token')).toBe('csrf-d');

    mockFetchOnce(fetchSpy, 200, { id: 'e1' });
    await api.entities.update('e1', { name: 'x' });
    expect(headersOf(fetchSpy, 1).get('X-CSRF-Token')).toBe('csrf-d');
  });

  it('omits X-CSRF-Token on POST when no csrf token in store', async () => {
    // open mode: no csrf token expected
    useAuthStore.setState({ ...initialAuthState, mode: 'open' });
    mockFetchOnce(fetchSpy, 200, { id: 'e1' });
    await api.entities.create({ type: 'concept', name: 'Test' });
    expect(headersOf(fetchSpy, 0).has('X-CSRF-Token')).toBe(false);
  });

  it('on 401 in pat mode, redirects to /login (hash route)', async () => {
    useAuthStore.setState({ ...initialAuthState, mode: 'pat', csrfToken: 'csrf' });
    window.location.hash = '';
    mockFetchOnce(fetchSpy, 401, { error: 'unauthorized' });

    await expect(api.entities.list()).rejects.toMatchObject({ status: 401 });

    expect(window.location.hash).toBe('#/login');
  });

  it('on 401 in open mode, does NOT redirect — error surfaces to caller', async () => {
    useAuthStore.setState({ ...initialAuthState, mode: 'open' });
    window.location.hash = '#/dashboard';
    mockFetchOnce(fetchSpy, 401, { error: 'unauthorized' });

    await expect(api.entities.list()).rejects.toMatchObject({ status: 401, message: 'unauthorized' });
    expect(window.location.hash).toBe('#/dashboard');
  });

  it('on 401 in unknown mode, does NOT redirect (avoids transient-error loops)', async () => {
    useAuthStore.setState({ ...initialAuthState, mode: 'unknown' });
    window.location.hash = '#/foo';
    mockFetchOnce(fetchSpy, 401, { error: 'unauthorized' });

    await expect(api.entities.list()).rejects.toMatchObject({ status: 401 });
    expect(window.location.hash).toBe('#/foo');
  });

  it('does not double-redirect when already on /login', async () => {
    useAuthStore.setState({ ...initialAuthState, mode: 'pat' });
    window.location.hash = '#/login';
    mockFetchOnce(fetchSpy, 401, { error: 'unauthorized' });

    await expect(api.entities.list()).rejects.toMatchObject({ status: 401 });
    expect(window.location.hash).toBe('#/login');
  });
});

describe('auth-store login()', () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    useAuthStore.setState(initialAuthState);
    if (typeof window === 'undefined') {
      vi.stubGlobal('window', { location: { hash: '', pathname: '/' } });
    } else {
      window.location.hash = '';
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('login success populates csrfToken + user and triggers a follow-up whoami', async () => {
    // First call: /api/auth/login → success
    mockFetchOnce(fetchSpy, 200, {
      csrfToken: 'csrf-after-login',
      userId: 'u1',
      email: 'a@b.dev',
    });
    // Second call: triggered bootstrap() → /api/auth/whoami
    mockFetchOnce(fetchSpy, 200, {
      userId: 'u1',
      email: 'a@b.dev',
      role: 'member',
      namespace: 'ns-1',
      csrfToken: 'csrf-after-whoami',
      relayUrl: 'wss://relay.example.dev',
    });

    const result = await useAuthStore.getState().login('a@b.dev', 'sbp_xxx');
    expect(result.ok).toBe(true);

    // Allow the void-promise from inside login() to settle.
    await new Promise((r) => setTimeout(r, 0));

    const state = useAuthStore.getState();
    expect(state.user?.email).toBe('a@b.dev');
    // bootstrap() ran and overwrote csrfToken with the latest from whoami
    expect(state.csrfToken).toBe('csrf-after-whoami');
    expect(state.mode).toBe('pat');
    expect(state.relayUrl).toBe('wss://relay.example.dev');

    // Verify login POST sent the correct body and credentials: include
    const loginCall = callOf(fetchSpy, 0);
    expect(loginCall.url).toBe('/api/auth/login');
    expect(loginCall.init.method).toBe('POST');
    expect(loginCall.init.credentials).toBe('include');
    const bodyStr = typeof loginCall.init.body === 'string' ? loginCall.init.body : '';
    expect(JSON.parse(bodyStr)).toEqual({ email: 'a@b.dev', pat: 'sbp_xxx' });
  });

  it('login 401 returns error and does NOT populate user', async () => {
    mockFetchOnce(fetchSpy, 401, { error: 'invalid credentials' });
    const result = await useAuthStore.getState().login('a@b.dev', 'wrong');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe('invalid credentials');
    }
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.csrfToken).toBeNull();
  });
});

describe('auth-store bootstrap()', () => {
  let fetchSpy: FetchMock;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    useAuthStore.setState(initialAuthState);
    if (typeof window === 'undefined') {
      vi.stubGlobal('window', { location: { hash: '', pathname: '/' } });
    } else {
      window.location.hash = '';
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('in open mode (whoami 200 with explicit mode:open) does NOT redirect', async () => {
    mockFetchOnce(fetchSpy, 200, { mode: 'open' });
    window.location.hash = '#/dashboard';

    await useAuthStore.getState().bootstrap();

    expect(window.location.hash).toBe('#/dashboard'); // no redirect
    expect(useAuthStore.getState().mode).toBe('open');
    expect(useAuthStore.getState().user).toBeNull(); // no user in open mode stub
    expect(useAuthStore.getState().csrfToken).toBeNull();
  });

  it('legacy back-compat: whoami 200 with userId+email but no mode falls back to open', async () => {
    mockFetchOnce(fetchSpy, 200, { userId: 'solo', email: 'solo@local' });
    window.location.hash = '#/dashboard';

    await useAuthStore.getState().bootstrap();

    expect(window.location.hash).toBe('#/dashboard');
    expect(useAuthStore.getState().mode).toBe('open');
    expect(useAuthStore.getState().user?.email).toBe('solo@local');
  });

  it('in pat mode (whoami 401) redirects to /login', async () => {
    mockFetchOnce(fetchSpy, 401, { error: 'auth required' });
    window.location.hash = '#/dashboard';

    await useAuthStore.getState().bootstrap();

    expect(window.location.hash).toBe('#/login');
    expect(useAuthStore.getState().mode).toBe('pat');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('whoami calls /api/auth/whoami with credentials: include', async () => {
    mockFetchOnce(fetchSpy, 200, { userId: 'u', email: 'e@e' });
    await useAuthStore.getState().bootstrap();
    const c = callOf(fetchSpy, 0);
    expect(c.url).toBe('/api/auth/whoami');
    expect(c.init.credentials).toBe('include');
  });
});
