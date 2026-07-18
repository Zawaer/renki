# Claude Remote Control (CRC)

Self-hosted, multi-device remote control for [Claude Code](https://claude.com/claude-code).
Run and watch multiple parallel Claude Code sessions across your repos from any
device — your Mac, VS Code, or your phone — with real-time sync and a
**take-control** lock so one device drives while the others watch live.

It runs entirely on your own hardware. Prompts and code only ever reach
Anthropic through the `claude` process the daemon runs locally; there is no
relay server.

## Why

Built to fix three specific frustrations with existing tools:

1. **Staleness** — no more "exit and rejoin to see updates". Every session is an
   append-only, sequence-numbered **event log**; clients fold it and reconnect
   by asking for "everything after seq N", so a reconnecting or late-joining
   device *cannot* miss anything. Staleness is impossible by construction, not
   patched over.
2. **Painless parallelism per repo** — each session runs in its own **git
   worktree** on a dedicated branch, so parallel sessions on the same repo never
   collide on file state.
3. **First-class multi-device control** — every connected device sees the live
   stream (tokens, tool calls, permission prompts); exactly one holds the lock
   and can prompt or approve. Taking control is instant.

Under the hood the daemon drives Claude via the official
`@anthropic-ai/claude-agent-sdk` (structured streaming + programmatic permission
callbacks) rather than scraping the interactive CLI — which is what makes the
whole thing robust.

**Optional multi-account rotation:** if you have more than one Claude account,
the daemon can automate the manual "swap accounts when I hit my limit" habit —
it drives [`cswap`](https://github.com/realiti4/claude-swap) to change which
account the official CLI loads at its next startup (never mid-turn, fail-safe,
never touching tokens itself). See [SETUP.md](./SETUP.md).

## Architecture

Monorepo (pnpm + Turbo):

| Package | What it is |
| --- | --- |
| `packages/protocol` | The shared contract: Zod schemas for domain types, the event log, and every WS/REST message. |
| `packages/client-core` | Pure-TS brain reused by every client: the event-log→state reducer, a reconnecting WebSocket client (replays from `lastSeq`), and the REST client. No DOM. |
| `apps/daemon` | Homelab service: spawns Claude sessions (SDK, resume-per-prompt), git worktrees, SQLite persistence, and one HTTP port serving REST + WebSocket. |
| `apps/web` | Reference client (React + Vite + Tailwind). Reused as-is inside the VS Code webview. |

`apps/vscode` embeds that same web bundle in a webview panel — the only
VS Code-specific code is config plumbing (daemon URL in settings, token in
SecretStorage) and a `postMessage` bridge (click a file in a tool call to open
it in your editor). `apps/mobile` is an Expo / React Native app that reuses
`client-core` + `protocol` (the views are RN-native, since DOM components can't
cross over) and adds push notifications for permission requests / turn
completion while backgrounded.

## Quick start

See **[SETUP.md](./SETUP.md)** for the full homelab + Tailscale walkthrough.

```bash
pnpm install && pnpm build
cp .env.example .env
pnpm --filter @crc/daemon cli token   # -> paste into .env as CRC_AUTH_TOKEN
pnpm --filter @crc/daemon dev          # start the daemon
pnpm --filter @crc/web dev             # open http://127.0.0.1:5173
```

Run the test suite (Vitest) with `pnpm test` — it covers the pure core: the
event-log→state reducer (determinism + replay==live), the daemon's event log
(seq monotonicity, gap-free replay), the rate-limit classifier, and the
SessionManager lock/single-writer invariants.

## Status

- [x] Protocol contract + daemon core (worktrees, SDK, persistence)
- [x] WebSocket + REST server with event-sourced replay & take-control lock
- [x] Shared `client-core` + React web app
- [x] Security: Tailscale-friendly, token auth, safe-bind guard
- [x] VS Code extension (webview reusing the web bundle + editor bridge)
- [x] Android app (Expo) + push notifications
- [x] Optional multi-account usage rotation (cswap)
- [x] Vitest unit suite over the pure core (reducer, event log, lock invariants)

All six build steps complete. Single-user, self-hosted, v1. Built as a portfolio project.
