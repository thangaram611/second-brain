import { create } from 'zustand';
import { z } from 'zod';

/**
 * Auth store — holds session state for the UI.
 *
 * IMPORTANT: csrfToken lives ONLY in memory. Never persist to localStorage /
 * sessionStorage / cookies — that would defeat the XSS protection of the
 * Secure HttpOnly session cookie.
 *
 * The session cookie itself is set by the server on /api/auth/login and
 * automatically attached by `credentials: 'include'` in api.ts. The CSRF
 * token returned alongside is added to the X-CSRF-Token header on writes.
 */

export type AuthMode = 'open' | 'pat' | 'unknown';

export interface AuthUser {
  id: string;
  email: string;
  namespace: string;
}

const WhoamiSchema = z.object({
  userId: z.string(),
  email: z.string(),
  // role/namespace may be omitted in 'open' mode — keep them optional and
  // fall back to sensible defaults rather than failing parse.
  role: z.string().optional(),
  namespace: z.string().optional(),
  csrfToken: z.string().optional(),
  // The server-side stream is adding this so the UI can drop the hardcoded
  // ws://localhost:7421 default. Optional for back-compat.
  relayUrl: z.string().optional(),
});

const LoginResponseSchema = z.object({
  csrfToken: z.string(),
  userId: z.string(),
  email: z.string(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

export type WhoamiResponse = z.infer<typeof WhoamiSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

interface AuthState {
  csrfToken: string | null;
  user: AuthUser | null;
  mode: AuthMode;
  /** Relay URL surfaced via whoami in pat-mode; null until known. */
  relayUrl: string | null;
  bootstrapped: boolean;
  loading: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  login: (email: string, pat: string) => Promise<{ ok: true } | { ok: false; error: string; status: number }>;
  logout: () => Promise<void>;
  /** Test/debug helper — never call from production UI code. */
  _setForTest: (patch: Partial<AuthState>) => void;
}

/**
 * Hard navigate to /login. We use `window.location` rather than a router
 * `navigate()` here because the auth-store is invoked from non-component
 * code paths (api.ts request helper). Using a hash route keeps it
 * compatible with HashRouter.
 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  // Avoid bouncing if we're already at /login.
  if (window.location.hash === '#/login' || window.location.pathname === '/login') return;
  window.location.hash = '#/login';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  csrfToken: null,
  user: null,
  mode: 'unknown',
  relayUrl: null,
  bootstrapped: false,
  loading: false,
  error: null,

  async bootstrap() {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/auth/whoami', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 401 || res.status === 403) {
        // 401 in 'unknown' mode: ask the server what mode we're in. If the
        // server returned a JSON body that includes a mode hint, honor it;
        // otherwise assume 'pat' (since open-mode whoami should never 401).
        let inferredMode: AuthMode = 'pat';
        const bodyParse = ErrorResponseSchema.safeParse(await res.json().catch(() => ({})));
        if (bodyParse.success && /open/i.test(bodyParse.data.error)) {
          inferredMode = 'open';
        }
        set({
          csrfToken: null,
          user: null,
          mode: inferredMode,
          bootstrapped: true,
          loading: false,
          error: null,
        });
        if (inferredMode === 'pat') redirectToLogin();
        return;
      }

      if (!res.ok) {
        // Server unreachable / 5xx — keep mode 'unknown' so the api.ts
        // 401 handler doesn't redirect on transient errors.
        set({
          mode: 'unknown',
          bootstrapped: true,
          loading: false,
          error: `whoami failed (${res.status})`,
        });
        return;
      }

      const json: unknown = await res.json();
      const parsed = WhoamiSchema.safeParse(json);
      if (!parsed.success) {
        set({
          mode: 'unknown',
          bootstrapped: true,
          loading: false,
          error: 'whoami response did not match expected schema',
        });
        return;
      }

      // If the response carries a csrfToken we're authed (pat-mode).
      // If not, the server is in 'open' mode — no auth required, no CSRF.
      const data = parsed.data;
      const mode: AuthMode = data.csrfToken ? 'pat' : 'open';
      set({
        csrfToken: data.csrfToken ?? null,
        user: {
          id: data.userId,
          email: data.email,
          namespace: data.namespace ?? 'default',
        },
        mode,
        relayUrl: data.relayUrl ?? null,
        bootstrapped: true,
        loading: false,
        error: null,
      });
    } catch (e) {
      // Network error — leave mode unknown, do NOT redirect (would loop).
      set({
        mode: 'unknown',
        bootstrapped: true,
        loading: false,
        error: e instanceof Error ? e.message : 'whoami failed',
      });
    }
  },

  async login(email, pat) {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pat }),
      });

      if (!res.ok) {
        const bodyParse = ErrorResponseSchema.safeParse(await res.json().catch(() => ({})));
        const errMsg = bodyParse.success ? bodyParse.data.error : `login failed (${res.status})`;
        set({ loading: false, error: errMsg });
        return { ok: false as const, error: errMsg, status: res.status };
      }

      const json: unknown = await res.json();
      const parsed = LoginResponseSchema.safeParse(json);
      if (!parsed.success) {
        const msg = 'login response did not match expected schema';
        set({ loading: false, error: msg });
        return { ok: false as const, error: msg, status: 500 };
      }

      set({
        csrfToken: parsed.data.csrfToken,
        user: {
          id: parsed.data.userId,
          email: parsed.data.email,
          // namespace will be populated by a follow-up bootstrap() call.
          namespace: get().user?.namespace ?? 'default',
        },
        mode: 'pat',
        loading: false,
        error: null,
      });

      // Refresh full whoami so we pick up namespace + relayUrl.
      void get().bootstrap();
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'login failed';
      set({ loading: false, error: msg });
      return { ok: false as const, error: msg, status: 0 };
    }
  },

  async logout() {
    try {
      const csrf = get().csrfToken;
      const headers: Record<string, string> = {};
      if (csrf) headers['X-CSRF-Token'] = csrf;
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers,
      });
    } catch {
      // best-effort — local state is cleared regardless.
    }
    set({
      csrfToken: null,
      user: null,
      mode: 'unknown',
      relayUrl: null,
      bootstrapped: true,
      loading: false,
      error: null,
    });
    redirectToLogin();
  },

  _setForTest(patch) {
    set(patch);
  },
}));
