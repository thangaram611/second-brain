import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { App } from './app.js';
import { useAuthStore } from './store/auth-store.js';
import './app.css';

// Bootstrap auth before the first render so api.ts knows the auth mode
// ('open' | 'pat' | 'unknown') the very first time a request fires. We
// don't await it — we want the UI to paint immediately. Components that
// need to react to auth state read it via useAuthStore subscriptions.
//
// The store handles the 401-redirect itself when mode === 'pat'.
void useAuthStore.getState().bootstrap();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element found');

createRoot(rootEl).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
