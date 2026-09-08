# Contributing to Renki

Thanks for taking a look. This is a young, solo-built project, so process is
intentionally light — the main thing is keeping the pure core (protocol +
client-core + daemon logic) well-tested, since every client depends on it.

## Development setup

```bash
git clone https://github.com/Zawaer/renki
cd renki
pnpm install
pnpm build       # compiles packages/protocol + packages/client-core (+ apps) to dist/
```

You'll also want the `claude` CLI installed and logged in locally — the daemon
drives it via the Agent SDK. See [SETUP.md](./SETUP.md) for the full run-it-
yourself walkthrough (daemon, web, VS Code, Android, Tailscale).

## Running things while you work

```bash
pnpm --filter @renki/daemon dev   # daemon, auto-reloads (tsx watch)
pnpm --filter @renki/web dev      # web client at http://127.0.0.1:5173
```

## Before opening a PR

```bash
pnpm build
pnpm typecheck
pnpm test
```

CI (`.github/workflows/ci.yml`) runs the same three commands on every push and
PR — please make sure they're clean locally first.

The test suite (Vitest) currently covers the parts that are cheapest to get
wrong and most expensive to get wrong quietly: the event-log→state reducer
(determinism, replay==live), the daemon's event log (seq monotonicity,
gap-free replay), the rate-limit classifier, the SessionManager's
lock/single-writer invariants, the account-rotation policy engine, the
permission broker's fail-safe deny-on-timeout, the diff/todo/plan tool-input
parsers shared by every client, and the legacy-session-id and merge-conflict
migrations. If you touch any of that, add a test.

## Where things live

See the [Architecture](./README.md#architecture) section of the README for the
package layout. A few pointers that aren't obvious from file names alone:

- **`packages/protocol`** is the contract every client and the daemon agree on
  (Zod schemas). Changing a message shape here is a breaking change across all
  four clients — grep for the type before renaming a field.
- **`packages/client-core`** has zero DOM/RN dependencies on purpose, so the
  exact same reducer and WebSocket client run in the browser, VS Code's
  webview, and React Native. If you're adding client logic, ask whether it
  belongs here (shared) or in the app (platform-specific view only).
- **`apps/daemon`** is the only thing that touches the filesystem, git, and the
  Agent SDK. Client apps never do.

## Reporting bugs / proposing features

Open a GitHub issue. For anything nontrivial, a quick issue describing the
problem before a big PR saves rework — especially for changes that touch
`packages/protocol`, since that ripples into every client.

[NEXT_STEPS.md](./NEXT_STEPS.md) tracks the live roadmap and known
fragilities; it's a reasonable place to look for what's genuinely useful to
pick up next.

## Security issues

Please don't open a public issue for a security vulnerability — see
[SECURITY.md](./SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
