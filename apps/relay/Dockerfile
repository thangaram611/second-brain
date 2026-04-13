# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1 — install full monorepo deps + source (shared by both build stages)
# -----------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /repo

# pnpm is installed via corepack to match the lockfile's packageManager field.
RUN corepack enable && corepack prepare pnpm@10.8.0 --activate

# Copy the workspace manifests first so pnpm can cache dep resolution.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.json ./
COPY apps/relay/package.json ./apps/relay/
COPY apps/server/package.json ./apps/server/
COPY apps/ui/package.json ./apps/ui/
COPY packages/collectors/package.json ./packages/collectors/
COPY packages/core/package.json ./packages/core/
COPY packages/ingestion/package.json ./packages/ingestion/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/sync/package.json ./packages/sync/
COPY packages/types/package.json ./packages/types/
COPY tools/cli/package.json ./tools/cli/

RUN pnpm install --frozen-lockfile

# Now copy source for the packages involved in the build.
COPY packages/ ./packages/
COPY apps/relay/ ./apps/relay/
COPY apps/ui/ ./apps/ui/

# -----------------------------------------------------------------------------
# Stage 2 — build the UI static bundle → /ui-dist
# -----------------------------------------------------------------------------
FROM deps AS ui-builder

RUN pnpm --filter @second-brain/types build \
 && pnpm --filter @second-brain/ui build

# -----------------------------------------------------------------------------
# Stage 3 — build the relay bundle and prepare a production deploy
# -----------------------------------------------------------------------------
FROM deps AS relay-builder

RUN pnpm --filter @second-brain/types build \
 && pnpm --filter @second-brain/relay build \
 && pnpm deploy --filter @second-brain/relay --prod /out

# -----------------------------------------------------------------------------
# Stage 4 — minimal runtime. glibc-based (node:22-slim) so native modules like
# better-sqlite3 pick up their prebuilt binaries reliably. Musl/Alpine works
# for pure-JS projects but trips on prebuilds; keep glibc here.
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=relay-builder /out ./
COPY --from=ui-builder /repo/apps/ui/dist /ui-dist

ENV NODE_ENV=production \
    RELAY_PORT=7421 \
    SERVE_UI=true \
    UI_DIST_DIR=/ui-dist \
    RELAY_PERSIST_DIR=/data

RUN mkdir -p /data && chown -R node:node /data /ui-dist /app
VOLUME ["/data"]

USER node
EXPOSE 7421

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:7421/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.mjs"]
