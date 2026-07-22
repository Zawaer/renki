# Next steps

All six build steps and the multi-account rotation feature are implemented and
committed. The pure core now has a Vitest unit suite (`pnpm test`) — the
event-log→state reducer, the daemon event log, the rate-limit classifier, and
the SessionManager lock/single-writer invariants. The parts that need a browser,
VS Code, an Android device, or live-exhausted accounts still can't be exercised
in the build environment. This is the punch list to finish on real hardware,
plus deferred enhancements — and, up top, the roadmap to turn this into a real
open-source project.

## ★ Roadmap: open-source + portfolio readiness (priority)

The engine is built (event-sourced daemon, worktree isolation, take-control
locking, careful auth, four clients, tests). Both goals — a useful OSS project
and a strong portfolio piece — are won or lost on the **on-ramp**, not on more
features. The throughline for everything below: shrink "found the repo" →
"running Claude from my phone" to a couple of minutes. Build in this order.

- [x] **P0 — Prove it end-to-end + OSS hygiene.** Full run done live (daemon +
      phone over Tailscale → session → stream → take-control). LICENSE (MIT),
      GitHub Actions CI (build + typecheck + test), the accidental root-level
      Expo artifacts cleaned up (twice — `expo prebuild` from the repo root
      keeps being a footgun, watch for it), and the Android package name
      settled on `com.zawaer.clauderemotecontrol`.
- [x] **P1a — QR device pairing.** Done: any connected client (web or phone)
      shows a QR of its own working `{ baseUrl, token }`
      (`packages/client-core/src/pairing.ts`); a new device scans it via
      "Scan QR code" on the mobile Setup screen instead of typing either value.
      Also detects a loopback-only connection (e.g. pairing from a browser on
      `127.0.0.1:4517` itself) and offers the daemon's real Tailscale address
      instead of showing a QR that would only ever point back at itself.
  - [x] **P1b — `crc init` wizard.** Done, narrower than originally scoped:
        writing `.env` turned out to be unnecessary — auto-generated tokens
        and `CRC_REPOS_ROOT`'s `~/coding` default mean there's often nothing
        to write. `crc init` (`apps/daemon/src/cli.ts`) reports the resolved
        token + repos found, detects Tailscale and offers to run
        `tailscale serve --bg <port>` (with a clear remediation message if
        the operator isn't set), then prints the first pairing QR straight
        to the terminal via `qrcode` — falling back to a clearly-labeled
        loopback QR if Tailscale isn't available rather than dead-ending.
        Closes the bootstrap gap where today's QR flow needs one client
        already configured by hand to onboard the rest. Verified both
        bare-metal and inside the Docker image.
- [x] **P2a — Docker packaging.** Done: multi-stage `Dockerfile` +
      `docker-compose.yml` for the daemon, scoped to just `@crc/daemon` +
      `@crc/protocol` (`pnpm deploy` — web/mobile/vscode's dependency trees
      never run in the image). Reuses the host's `~/.claude` and repos via
      bind mounts; the auth token auto-generates the same way as bare-metal.
      Verified end to end on a real Linux homeserver (build, `cli.js repos`
      sanity check, `up -d`, `tailscale serve` in front). SETUP.md now leads
      with this path over pm2/bare-metal. Added a second `web` service
      (`Dockerfile.web`, static build served by nginx) alongside it — one
      `docker compose up` now brings up both the daemon and the actual UI,
      matching what `ecosystem.config.cjs` already does for pm2 with
      `crc-daemon` + `crc-web`. Prompted by a real homelab setup: someone
      pointed their own Caddy at the daemon expecting a webpage and got a
      bare `{"error":"unauthorized"}` — the daemon has no UI of its own.
  - [x] **P2b (half) — Prebuilt image.** Done:
        `.github/workflows/docker-publish.yml` builds both images
        (`Dockerfile`'s `runtime` target for the daemon, `Dockerfile.web`'s
        for the web UI) and pushes to GHCR
        (`ghcr.io/zawaer/claude-remote-control` +
        `…-web`) on every push to `main` (tag `latest` + `main-<sha>`) and on
        `v*.*.*` tags (semver tags, no `latest`). Uses `GITHUB_TOKEN` only —
        no registry secret to configure. Both Dockerfiles built locally
        against the exact same target the workflow uses to confirm they're
        green before relying on CI. Still needs: the repo flipped to public
        (GHCR packages under a private repo aren't pullable without auth) and
        `docker-compose.yml`/SETUP.md updated to offer `image:` as an
        alternative to `build:` once a few tagged releases exist. No prebuilt
        Android APK / Expo Go path yet — that half is still open.
- [x] **P3a — README + architecture + security docs.** Done: README has a
      one-paragraph what/why, a features list, a Mermaid architecture diagram,
      a 3-step quickstart, and Contributing/Security/License pointers.
      CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, and GitHub issue/PR
      templates added.
  - [x] **P3b — Networking alternatives documented.** SETUP.md § 4 now covers
        Caddy (reverse proxy for a real domain/HTTPS, orthogonal to Tailscale),
        Headscale (self-hosted alternative to Tailscale's control plane), and
        an explicit warning against direct public exposure given the daemon's
        code-execution blast radius. SECURITY.md cross-references it.
  - [ ] **P3c — Demo GIF.** Still open: a ~60s screen recording of the actual
        take-control handoff. Needs a human to record it — this is genuinely
        worth doing before the repo goes public, it's the thing that gets
        someone to actually try the quickstart.
  - [ ] The repo is currently **private** on GitHub. Flip to public when ready
        (and consider setting the repo's About description/topics — see the
        `description` field already in the root `package.json` for text to reuse).

**Deliberately skipped for now** (revisit only on real demand):

- **Central/hosted relay** for people without a server. Big shift: you'd be
  relaying arbitrary-code-execution sessions = real cost/abuse/liability, and it
  centralizes a decentralized tool. If ever built, only as a *blind* relay (à la
  Tailscale DERP) that never sees plaintext or the token, with auth kept
  end-to-end. The better answer to "no homelab" is lowering the self-host bar
  (P1/P2), not becoming the host.
- **Account-based auth.** The single shared bearer token is the correct minimal
  design for self-hosting + tailnet; accounts only start earning their keep once
  a multi-tenant relay exists. Fix the token's *UX* (QR pairing, P1), not the
  mechanism.

## 0. Test coverage (done)

- [x] **Pure core unit tests.** Reducer determinism + replay==live, event-log
      seq/replay/gap-free handoff, `classifyRateLimit`, SessionManager guards.
- [x] **Server integration tests.** Done (`test/server.test.ts`): the real
      Fastify + WS server in-process, driven over a real socket — REST
      auth/CRUD, and the subscribe → replay → live handoff (no live `claude`;
      "live" events are appended directly to the log, same trick
      session-manager.test.ts uses). Caught a real bug along the way: a
      rejected WS upgrade (bad token) leaked its raw socket forever, because
      `@fastify/websocket`'s cleanup hook only runs if its own onRequest hook
      (registered after auth) got a chance to run first — fixed by
      registering the plugin before the auth hook.
- [x] **Reducer tests reused by clients.** Done (`apps/web/test/SessionView.test.tsx`):
      renders the real `SessionView` against real `applyEvents` output (a
      `ClientContext.Provider` stub, never-connected `RealtimeClient` — no
      mocked reducer or hand-typed fake state), covering a full transcript
      (prompt, thinking, tool use + result, final text, cost, notice),
      pending-permission actionability by controller, and the empty/unlocked
      state. Web-only for now — mobile's React Native testing setup (jest-expo
      + native mocks) is a heavier lift than this "light" scope called for.
      Along the way, found and fixed a real pnpm/Vitest infra bug (not a code
      bug): `node-linker=hoisted` (needed for Expo/Metro) was creating
      separate physical React 19 copies for `react-dom` and
      `@testing-library/react` instead of symlinking web's own — same
      version everywhere, but genuinely different module instances, so any
      hook crashed. Never affected the shipped app (Vite bundles its own
      consistent graph) — only Node-based tooling. Fixed by
      `scripts/dedupe-react-for-tests.mjs`, wired as `postinstall`.

## 1. Verify on real hardware (partly done)

- [x] **Full stack once through.** Verified 2026-07-22 (Playwright driving the
      real dev-server web app against a real local daemon): connect, create a
      session in a real repo, send a prompt, watch it stream token-by-token,
      turn completes with cost/duration. Also surfaced an undocumented-but-real
      feature along the way: omitting `repoId` in `CreateSessionRequest`
      creates a repo-less "just chat" session (`data/chats/<id>`, no worktree)
      — see `packages/protocol/src/rest.ts`.
- [x] **Take-control handoff.** Verified 2026-07-22 (two browser contexts, same
      session): the second window's "Take control" correctly moves the lock,
      and the first window updates live (`"Controlled by <name>"`, its own
      composer disables) with no reload needed.
- [x] **Reconnect resilience.** Verified 2026-07-22: kill `-9`'d the daemon
      mid-turn (a streaming response, WS connection dropped) and restarted it.
      The client correctly detected the drop (header → "offline"), then
      auto-reconnected and replayed the full history with no manual reload.
      This surfaced a real bug: the turn in flight at kill time was left
      permanently wedged at `status: "busy"` (`SessionManager`'s `activeQueries`
      map is in-memory only, so a restart lost all record of it with no
      reconciliation on boot) — Stop errored `not_busy`, and a new prompt just
      queued forever. **Fixed** the same day:
      `SessionManager.reconcileOrphanedTurns()` (`apps/daemon/src/sessions/manager.ts`),
      called once at boot from `index.ts`, scans for any session row left
      `busy`, synthesizes a failed `turn_result` for the dangling turn (and
      `permission_resolved: deny` for any dangling permission request), and
      marks the session `error` so it's usable again. Covered by three new
      tests in `test/session-manager.test.ts`.
- [ ] **VS Code extension.** Open `apps/vscode`, press F5, set `crc.daemonUrl` +
      run "Set Auth Token", open the panel. Confirm file links open worktree files.
- [ ] **Android app.** `pnpm --filter @crc/mobile start`, run on a device via
      Expo Go; verify session list, streaming, take-control, permission approve.
- [ ] **Push notifications.** Needs an EAS `projectId` in `app.json` and a dev
      build (`npx expo run:android` or `eas build`). Confirm a push arrives when a
      permission request fires while the app is backgrounded, and tapping it opens
      the session.

## 2. Configuration to finish (multi-account)

- [ ] **Usage %.** Copy `apps/daemon/usage-accounts.example.json` to
      `data/usage-accounts.json` and fill in each account's claude.ai `sessionKey`
      + `orgId` (match `email` to cswap). Lights up the usage bars and enables the
      proactive threshold trigger.
- [ ] **Live rate-limit test.** Actually exhaust an account and confirm the
      daemon switches + retries once, with the inline notice showing.
- [ ] **Resume-survives-swap.** Confirm a session resumes correctly across a real
      `cswap` switch (expected to work — cswap swaps creds, not transcripts).
- [ ] **Decide `CRC_FORCE_PERMISSION_PROMPTS`.** On = every tool asks the
      controller (good for approve-from-phone); off = inherit your `~/.claude`
      allow-list. Pick once the phone client is in use.

## 3. Deferred enhancements

- [x] **Live session-list updates.** Done (`125caaa`): a fleet-wide `session`/
      `session_removed` WS push (`apps/daemon/src/server/connection.ts`,
      `packages/protocol/src/ws.ts`) fires on every `SessionManager` mutation
      via one `patch()` chokepoint, consumed by both web and mobile
      (`realtime.onSessionChanged`/`onSessionRemoved`). The old 4s REST poll
      is kept as a 30s safety net for changes missed during a disconnect.
- [x] **Stop/interrupt button.** Done — `SessionManager.interruptSession`
      (`apps/daemon/src/sessions/manager.ts`) calls the live `Query`'s
      `interrupt()`, wired to a Stop control in both the web and mobile composers.
- [x] **Delta-event compaction.** Done: `EventLog.compactBlock()`
      (`apps/daemon/src/events/log.ts`) deletes a (turnId, blockIndex)'s
      `assistant_delta` rows the instant its canonical `assistant_block`
      lands, called from `SessionManager`'s single `emit` chokepoint
      (`apps/daemon/src/sessions/manager.ts`). Safe because the reducer's
      `applyBlock()` already overwrites accumulated delta text with the
      block's canonical text, so replay is identical with or without the
      deltas once the block exists. Doesn't touch `seq` allocation, so it
      can't reopen the gap-free replay/live handoff. Covered by three new
      tests in `test/event-log.test.ts`.
- [x] **Usage reader org-id auto-resolve.** Done: `UsageReader.autoResolveOrgId()`
      (`apps/daemon/src/accounts/usage.ts`) fires from `fetchEntry()` whenever
      an entry has no `orgId` yet — e.g. a hand-edited `usage-accounts.json`
      with just a `sessionKey` — and persists the resolved id back to the
      file. Only auto-picks when the key sees exactly one org; a key on
      multiple orgs still needs the UI's org picker (a real choice can't be
      guessed), same as before. Covered by four new tests in
      `test/usage.test.ts` (previously zero coverage on this module) via a
      fake swapped in for the private `http` client.

## 4. Known fragilities

- The claude.ai usage endpoint is undocumented/reverse-engineered — the usage-%
  reader may need a tweak if Anthropic changes it (the rate-limit trigger does
  not depend on it).
- Multi-account rotation requires `cswap` installed with accounts added; the
  daemon degrades gracefully (no accounts → feature simply hidden).
- **Node's own `localStorage` global can shadow jsdom's in `apps/web`'s Vitest
  suite.** Hit on Node v25: `globalThis.localStorage` resolved to Node's own
  experimental Web Storage implementation (present but non-functional without
  a `--localstorage-file` path — `setItem`/`getItem` throw), so any component
  reading it (`src/lib/permissionModePrefs.ts`) crashed mid-render and most of
  `SessionView.test.tsx` failed with an empty rendered tree. Fixed by
  `apps/web/test/setup.ts` installing its own in-memory `Storage` polyfill
  over `globalThis.localStorage` (cleared after each test). Also surfaced (once
  the crash stopped masking it) one genuinely stale assertion in the same file
  — a `submitPrompt` opts expectation predating the `permissionMode` field
  added by the "Persist permission mode…" commit — now fixed to match.
