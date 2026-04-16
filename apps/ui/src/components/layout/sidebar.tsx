import { useState } from 'react';
import { NavLink } from 'react-router';
import {
  LayoutDashboard,
  Network,
  Search,
  Settings,
  Brain,
  Calendar,
  Scale,
  AlertTriangle,
  Upload,
  Users,
  Radio,
} from 'lucide-react';
import { useSyncStore } from '../../store/sync-store.js';
import { ImportDialog } from '../import-dialog.js';

const mainNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/graph', icon: Network, label: 'Graph' },
  { to: '/search', icon: Search, label: 'Search' },
];

const temporalNavItems = [
  { to: '/timeline', icon: Calendar, label: 'Timeline' },
  { to: '/decisions', icon: Scale, label: 'Decisions' },
  { to: '/contradictions', icon: AlertTriangle, label: 'Contradictions' },
];

const teamNavItems = [
  { to: '/ownership', icon: Users, label: 'Ownership' },
  { to: '/wip-radar', icon: Radio, label: 'WIP Radar' },
];

const bottomNavItems = [
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const totalPeers = useSyncStore(s => s.statuses.reduce((sum, st) => sum + st.connectedPeers, 0));
  const [importOpen, setImportOpen] = useState(false);

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-4">
        <Brain className="h-5 w-5 text-indigo-400" />
        <span className="font-semibold text-zinc-100">Second Brain</span>
      </div>

      <nav className="flex-1 px-2 py-3">
        {mainNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        <div className="mt-4 mb-1 border-t border-zinc-800 pt-3">
          <span className="px-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
            Temporal
          </span>
        </div>

        {temporalNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        <div className="mt-4 mb-1 border-t border-zinc-800 pt-3">
          <span className="px-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
            Team
          </span>
        </div>

        {teamNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        <div className="mt-4 border-t border-zinc-800 pt-3" />

        {bottomNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-zinc-800 px-4 py-3">
        <button
          onClick={() => setImportOpen(true)}
          className="mb-2 flex w-full items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Upload className="h-3.5 w-3.5" />
          Import graph
        </button>
        {totalPeers > 0 && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            {totalPeers} peer{totalPeers !== 1 ? 's' : ''} connected
          </div>
        )}
        <p className="text-xs text-zinc-600">v0.1.0</p>
      </div>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </aside>
  );
}
