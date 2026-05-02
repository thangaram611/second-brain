import { Routes, Route, useLocation } from 'react-router';
import { Sidebar } from './components/layout/sidebar.js';
import { Dashboard } from './components/pages/dashboard.js';
import { SearchPage } from './components/pages/search.js';
import { GraphExplorer } from './components/pages/graph-explorer.js';
import { EntityPage } from './components/pages/entity-page.js';
import { SettingsPage } from './components/pages/settings.js';
import { TimelinePage } from './components/pages/timeline.js';
import { DecisionsPage } from './components/pages/decisions.js';
import { ContradictionsPage } from './components/pages/contradictions.js';
import { OwnershipPage } from './components/pages/ownership.js';
import { WipRadarPage } from './components/pages/wip-radar.js';
import { LoginPage } from './pages/login.js';
import { useWebSocket } from './hooks/use-websocket.js';

export function App() {
  const location = useLocation();
  // The login page is a fullscreen route — no sidebar, no websocket. We
  // also avoid mounting useWebSocket() on /login so we don't open a WS
  // connection before the user is authenticated.
  const isLogin = location.pathname === '/login';

  if (isLogin) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    );
  }

  return <AuthedShell />;
}

function AuthedShell() {
  useWebSocket();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/graph" element={<GraphExplorer />} />
          <Route path="/graph/:id" element={<GraphExplorer />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/entities/:id" element={<EntityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/contradictions" element={<ContradictionsPage />} />
          <Route path="/ownership" element={<OwnershipPage />} />
          <Route path="/wip-radar" element={<WipRadarPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </main>
    </div>
  );
}
