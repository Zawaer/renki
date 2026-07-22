# syntax=docker/dockerfile:1
# Builds just @crc/daemon (+ its workspace deps, @crc/protocol and
# @crc/client-core) for an always-on host. Web/VS Code/mobile clients aren't
# part of this image.

FROM node:20-bookworm-slim AS base

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

# Dev target: branches off here, before any source is copied in or built —
# docker-compose.dev.yml bind-mounts live source over /app instead, and tsx
# watches + recompiles in-process, so this target never needs rebuilding
# after the first `--build` (only `base` reruns, and only on a
# package.json/lockfile change). Still the real Debian image + real
# node_modules (native deps like better-sqlite3 compiled for the container,
# not the host) — just without the tsc/deploy steps or the runtime stage's
# claude-swap install, which this target skips.
FROM base AS dev
RUN git config --system --add safe.directory '*'
# Not inherited from `base` — only the `runtime` stage set this before, but a
# host's docker-compose.override.yml (RTK's bind-mounted binary) expects it
# here too, same as in runtime.
ENV PATH="/root/.local/bin:${PATH}"
CMD ["pnpm", "--filter", "@crc/daemon", "dev"]

FROM base AS builder

# Now bring in the actual source and build — only these steps (fast tsc
# compiles) re-run on an ordinary code change, not the install above.
COPY . .

RUN pnpm --filter @crc/protocol build && pnpm --filter @crc/client-core build && pnpm --filter @crc/daemon build

# Self-contained prod-only output: resolves the @crc/protocol workspace
# dependency to its built dist rather than a symlink.
RUN pnpm --filter @crc/daemon deploy --prod /app/deploy

FROM node:20-bookworm-slim AS runtime

# git: the daemon shells out to it (via simple-git) to create a worktree per
# session against your mounted repos. python3: sessions run inside this
# container (not the host), so a Claude session's own Bash tool calls need it
# on PATH too, same as it'd be on a normal dev machine.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

# Your repos are bind-mounted from the host, so they're owned by your host
# user, not by this container's root — git 2.35.2+ refuses to touch a
# directory it doesn't consider "owned" by the running user (CVE-2022-24765)
# and fails every git call with "detected dubious ownership". Everything
# under /repos is already yours by definition (you mounted it in), so there's
# no privilege boundary being crossed here — trust the whole tree.
RUN git config --system --add safe.directory '*'

# cswap (optional multi-account usage rotation — see SETUP.md § Multi-account
# usage rotation) is normally a pipx-managed Python package on the host, but
# its installed shim script's shebang points at a host-only venv path
# (~/.local/share/pipx/venvs/claude-swap/bin/python), so bind-mounting just
# that file the way RTK's single binary gets mounted doesn't work — it needs
# installing into the image itself instead. It also requires Python 3.12+,
# newer than bookworm-slim's system python3 (3.11), so plain
# apt-get python3/pipx can't satisfy it — use uv instead, which downloads its
# own standalone Python build rather than depending on the distro's version.
ENV PATH="/root/.local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && uv python install 3.12 \
    && uv tool install claude-swap --python 3.12

WORKDIR /app
COPY --from=builder /app/deploy .

ENV NODE_ENV=production
EXPOSE 4517

CMD ["node", "dist/index.js"]
