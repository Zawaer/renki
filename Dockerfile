# Builds just @crc/daemon (+ its workspace deps, @crc/protocol and
# @crc/client-core) for an always-on host. Web/VS Code/mobile clients aren't
# part of this image.

FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY . .

# Skip Chromium download for the optional Playwright-based "guided usage
# login" — it's a Mac-only convenience feature, not needed for a headless image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Scoped to @crc/daemon + its workspace deps, so web/mobile/vscode's
# dependency trees (and their install-time scripts) never run here.
RUN pnpm install --frozen-lockfile --filter "@crc/daemon..."

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

WORKDIR /app
COPY --from=builder /app/deploy .

ENV NODE_ENV=production
EXPOSE 4517

CMD ["node", "dist/index.js"]
