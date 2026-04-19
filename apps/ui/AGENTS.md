# apps/ui — Agent Instructions

React 19 web app for visualizing and interacting with the knowledge graph.

## Entry Point

`src/main.tsx` → React root. Port **5173** (Vite dev server).

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/components/` | React components |
| `src/store/` | Zustand stores (one per feature) |
| `src/hooks/` | Custom React hooks |
| `src/lib/` | Utilities — `api.ts` (REST client), `ws.ts` (WebSocket) |

## Zustand Stores

| Store | Purpose |
|-------|---------|
| `graph-store.ts` | Graph data + Cytoscape.js state |
| `search-store.ts` | Search queries and results |
| `timeline-store.ts` | Temporal navigation |
| `sync-store.ts` | Sync status and controls |
| `stats-store.ts` | Dashboard statistics |
| `ownership-store.ts` | Entity ownership |
| `contradictions-store.ts` | Contradiction detection results |
| `wip-store.ts` | Work-in-progress entities |

## Conventions

- React 19 functional components only
- Zustand stores — one per feature, never mix concerns
- Cytoscape.js with diff-based rendering (not full re-render)
- Tailwind CSS dark theme (`zinc-950` background)
- HashRouter (React Router 7)
- REST client in `src/lib/api.ts` — all API calls go through this
- WebSocket in `src/lib/ws.ts` — auto-reconnect on disconnect
