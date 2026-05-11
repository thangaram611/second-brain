import { lazy, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router';
import { Sidebar } from './components/layout/sidebar.js';
import { LoginPage } from './pages/login.js';
import { useWebSocket } from './hooks/use-websocket.js';
import { LoadingState } from './components/ui/loading.js';

const Dashboard = lazy(() =>
  import('./components/pages/dashboard.js').then(({ Dashboard }) => ({ default: Dashboard })),
);
const SearchPage = lazy(() =>
  import('./components/pages/search.js').then(({ SearchPage }) => ({ default: SearchPage })),
);
const GraphExplorer = lazy(() =>
  import('./components/pages/graph-explorer.js').then(({ GraphExplorer }) => ({ default: GraphExplorer })),
);
const EntityPage = lazy(() =>
  import('./components/pages/entity-page.js').then(({ EntityPage }) => ({ default: EntityPage })),
);
const SettingsPage = lazy(() =>
  import('./components/pages/settings.js').then(({ SettingsPage }) => ({ default: SettingsPage })),
);
const TimelinePage = lazy(() =>
  import('./components/pages/timeline.js').then(({ TimelinePage }) => ({ default: TimelinePage })),
);
const DecisionsPage = lazy(() =>
  import('./components/pages/decisions.js').then(({ DecisionsPage }) => ({ default: DecisionsPage })),
);
const ContradictionsPage = lazy(() =>
  import('./components/pages/contradictions.js').then(({ ContradictionsPage }) => ({
    default: ContradictionsPage,
  })),
);
const OwnershipPage = lazy(() =>
  import('./components/pages/ownership.js').then(({ OwnershipPage }) => ({ default: OwnershipPage })),
);
const WipRadarPage = lazy(() =>
  import('./components/pages/wip-radar.js').then(({ WipRadarPage }) => ({ default: WipRadarPage })),
);

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
        <Suspense fallback={<LoadingState message="Loading page..." />}>
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
        </Suspense>
      </main>
    </div>
  );
}
