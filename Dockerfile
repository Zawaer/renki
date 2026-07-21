# syntax=docker/dockerfile:1
# Builds just @crc/daemon (+ its workspace deps, @crc/protocol and
# @crc/client-core) for an always-on host. Web/VS Code/mobile clients aren't
# part of this image.

FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Manifests only, before any source — so `pnpm install` (registry downloads +
# native module compilation, the actually slow part) is a Docker layer that
# stays cached across ordinary source edits, and only re-runs when a
# package.json/lockfile changes. pnpm needs every workspace member's
# package.json present to resolve the graph, even though --filter below only
# installs @crc/daemon's slice of it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY apps/daemon/package.json apps/daemon/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/vscode/package.json apps/vscode/package.json

# Skip Chromium download for the optional Playwright-based "guided usage
# login" — it's a Mac-only convenience feature, not needed for a headless image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Scoped to @crc/daemon + its workspace deps, so web/mobile/vscode's
# dependency trees (and their install-time scripts) never run here. The cache
# mount persists pnpm's package store across builds on the same Docker host,
# so even a genuine dependency change doesn't re-hit the registry for
# packages you already have.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@crc/daemon..."

# Now bring in the actual source and build — only these steps (fast tsc
# compiles) re-run on an ordinary code change, not the install above.
COPY . .

RUN pnpm --filter @crc/protocol build && pnpm --filter @crc/client-core build && pnpm --filter @crc/daemon build

# Self-contained prod-only output: resolves the @crc/protocol workspace
# dependency to its built dist rather than a symlink.
RUN pnpm --filter @crc/daemon deploy --prod /app/deploy

FROM node:20-bookworm-slim AS runtime

# git: the daemon shells out to it (via simple-git) to create a worktree per
# session against your mounted repos.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Your repos are bind-mounted from the host, so they're owned by your host
# user, not by this container's root — git 2.35.2+ refuses to touch a
# directory it doesn't consider "owned" by the running user (CVE-2022-24765)
# and fails every git call with "detected dubious ownership". Everything
# under /repos is already yours by definition (you mounted it in), so there's
# no privilege boundary being crossed here — trust the whole tree.
RUN git config --system --add safe.directory '*'

WORKDIR /app
COPY --from=builder /app/deploy .

ENV NODE_ENV=production
EXPOSE 4517

CMD ["node", "dist/index.js"]
