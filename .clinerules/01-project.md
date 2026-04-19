# Second Brain — Project Rules

Developer knowledge graph. pnpm monorepo, Turborepo, Node.js 22+, TypeScript 5.8+ strict, ESM only.

## References
- Full architecture: docs/architecture.md
- Agent instructions: AGENTS.md
- API reference: docs/api-reference.md
- Getting started: docs/getting-started.md

## Commands
```bash
pnpm install          # Install dependencies
pnpm build            # Build all (cached via Turbo)
pnpm test             # Run all tests
pnpm check-types      # Type-check everything
pnpm dev              # Dev servers (API:7430, UI:5173, Relay:7421)
```

## Monorepo
packages/types, core, collectors, ingestion, sync, mcp-server
apps/server (Express 5, port 7430), ui (React 19, port 5173), relay (Hocuspocus, port 7421)
tools/cli (brain CLI)
