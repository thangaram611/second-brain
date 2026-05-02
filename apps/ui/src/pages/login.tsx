import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LogIn } from 'lucide-react';
import { useAuthStore } from '../store/auth-store.js';
import { Card } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';

/**
 * Login page — minimal email + PAT form.
 *
 * On success the server sets a Secure HttpOnly SameSite=Lax session cookie
 * and returns { csrfToken, userId, email }. The auth-store stores the CSRF
 * token in memory only (never localStorage — XSS surface).
 */
export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);
  const storeError = useAuthStore((s) => s.error);

  const [email, setEmail] = useState('');
  const [pat, setPat] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!email || !pat) {
      setLocalError('Email and PAT are required.');
      return;
    }
    const result = await login(email, pat);
    if (result.ok) {
      navigate('/');
      return;
    }
    // Surface server message verbatim — for 401/403 the server returns a
    // plain { error } payload like "invalid credentials".
    if (result.status === 401 || result.status === 403) {
      setLocalError(result.error || 'Invalid email or PAT.');
    } else {
      setLocalError(result.error || 'Login failed. Please try again.');
    }
  }

  const errorMessage = localError ?? storeError;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold text-zinc-100">
          <LogIn className="h-5 w-5 text-indigo-400" />
          Sign in to Second Brain
        </h1>
        <p className="mb-5 text-sm text-zinc-500">
          Use your email and a personal access token (PAT) issued by your admin.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-zinc-400">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.dev"
              autoComplete="email"
              autoFocus
              required
            />
          </div>
          <div>
            <label htmlFor="pat" className="mb-1 block text-xs font-medium text-zinc-400">
              Personal Access Token
            </label>
            <Input
              id="pat"
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="sbp_..."
              autoComplete="current-password"
              required
            />
          </div>

          {errorMessage && (
            <p
              role="alert"
              aria-live="polite"
              className="rounded-md border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-300"
            >
              {errorMessage}
            </p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
