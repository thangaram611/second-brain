import { Routes, Route } from 'react-router';
import { Sidebar } from './components/layout/sidebar.js';
import { Dashboard } from './components/pages/dashboard.js';
import { SearchPage } from './components/pages/search.js';
import { GraphExplorer } from './components/pages/graph-explorer.js';
import { EntityPage } from './components/pages/entity-page.js';
import { SettingsPage } from './components/pages/settings.js';
import { useWebSocket } from './hooks/use-websocket.js';

export function App() {
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
        </Routes>
      </main>
    </div>
  );
}
