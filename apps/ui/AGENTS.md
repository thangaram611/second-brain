# apps/ui — Agent Instructions

React 19 web app for visualizing and interacting with the knowledge graph.

## Entry Point

`src/main.tsx` → React root. Port **5173** (Vite dev server).

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/components/` | React components |
| `src/store/` | Zustand stores — client-only state (see below) |
| `src/hooks/` | Custom React hooks (`use-graph.ts`, `use-websocket.ts`, `use-debounce.ts`) |
| `src/lib/` | Utilities — `api.ts` (REST client), `ws.ts` (WebSocket), `query-client.ts` / `query-keys.ts` (TanStack Query), `ws-cache.ts` (live-update cache reducers) |

## State management

Server state lives in **TanStack Query** (`@tanstack/react-query`). Each page
calls `useQuery` / `useMutation` keyed via the `src/lib/query-keys.ts` factory;
the `queryClient` singleton in `src/lib/query-client.ts` lets non-component code
(WebSocket handlers) patch caches with `setQueryData`. The accumulated graph
cache + entity mutations are wrapped in `src/hooks/use-graph.ts`.

Zustand is used **only for true client state**:

| Store | Purpose |
|-------|---------|
| `auth-store.ts` | Session: csrfToken / user / mode / relayUrl |

UI-local state (search query, timeline/ownership filters, graph selection) is
plain component `useState`.

## Conventions

- React 19 functional components only
- Server state via TanStack Query (never hand-rolled caches or Zustand for server data)
- WebSocket live updates patch query caches via pure reducers in `lib/ws-cache.ts`
- Cytoscape.js with diff-based rendering (not full re-render)
- Tailwind CSS dark theme (`zinc-950` background)
- HashRouter (React Router 7)
- REST client in `src/lib/api.ts` — all API calls go through this
- WebSocket in `src/lib/ws.ts` — auto-reconnect, Zod-validated event union
