# Security policy

Renki gives connected devices the ability to drive a real
`claude` process on your machine — a genuine "run things on my computer"
surface. Reports about auth bypass, the take-control lock, session isolation
(worktrees), or the daemon's network exposure are all in scope and taken
seriously.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security problem.

Instead, use GitHub's private reporting: go to the **Security** tab of this
repository → **Report a vulnerability**. That opens a private advisory only
visible to the maintainer, so details don't sit in the public issue tracker
before there's a fix.

Include what you'd normally include in a report: the affected component
(daemon / a specific client), reproduction steps, and the impact you think
it has.

## Scope

In scope:
- The daemon's HTTP/WebSocket server and its auth (`apps/daemon/src/server`)
- The take-control lock and session isolation (git worktrees)
- The clients' handling of the auth token / session credentials
- The QR device-pairing payload (`packages/client-core/src/pairing.ts`)

Out of scope:
- Anthropic's own infrastructure (the `claude` CLI, the Agent SDK, claude.ai) —
  report those to Anthropic directly.
- Issues that require the attacker to already have your `RENKI_AUTH_TOKEN` **and**
  network access to your daemon — that's the intended trust boundary (see the
  security model below), not a bypass of it.

## Current security model

Renki is single-user, self-hosted software with a deliberately small trust
boundary — worth understanding before reporting something that's a known
design tradeoff rather than a bug:

- **No relay.** The daemon runs on your own hardware; prompts and code only
  ever reach Anthropic through the `claude` process it spawns locally.
- **Network boundary:** the daemon binds to loopback by default. The
  recommended way to reach it from other devices is
  [Tailscale](https://tailscale.com) (WireGuard) — never the public internet.
  Direct public exposure is technically possible but not a hardened path (no
  built-in rate limiting) — see
  [SETUP.md § Advanced: other networking options](./SETUP.md#advanced-other-networking-options)
  before considering it.
- **Auth:** a single shared bearer token (`RENKI_AUTH_TOKEN`), compared in
  constant time, required on every request including the WebSocket upgrade.
  The daemon refuses to bind a non-loopback host without one.
- **Session isolation:** each session runs in its own git worktree, so
  parallel sessions can't collide on file state.

Full detail lives in [SETUP.md § Security model](./SETUP.md#security-model-single-user-v1).

Supported versions: this project doesn't yet have tagged releases — fixes
land on `main`.
