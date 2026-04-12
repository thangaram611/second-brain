import { NavLink } from 'react-router';
import {
  LayoutDashboard,
  Network,
  Search,
  Settings,
  Brain,
} from 'lucide-react';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/graph', icon: Network, label: 'Graph' },
  { to: '/search', icon: Search, label: 'Search' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  return (
    <aside className="flex h-screen w-56 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-4">
        <Brain className="h-5 w-5 text-indigo-400" />
        <span className="font-semibold text-zinc-100">Second Brain</span>
      </div>

      <nav className="flex-1 px-2 py-3">
        {navItems.map((item) => (
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
      </nav>

      <div className="border-t border-zinc-800 px-4 py-3">
        <p className="text-xs text-zinc-600">v0.1.0</p>
      </div>
    </aside>
  );
}
