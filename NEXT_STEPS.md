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
      with this path over pm2/bare-metal.
  - [ ] **P2b — Prebuilt image + Android APK.** Still open: no image
        published to a registry yet — still `git clone` + a local
        `docker build` (~1-2 min), not a true one-liner. Needs a GitHub
        Actions publish workflow (deliberately deferred, bigger lift:
        registry choice, versioning, CI changes). No prebuilt Android APK /
        Expo Go path either.
- [x] **P3a — README + architecture + security docs.** Done: README has a
      one-paragraph what/why, a features list, a Mermaid architecture diagram,
      a 3-step quickstart, and Contributing/Security/License pointers.
      CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, and GitHub issue/PR
      templates added.
  - [ ] **P3b — Demo GIF.** Still open: a ~60s screen recording of the actual
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

## 0. Test coverage (started)

- [x] **Pure core unit tests.** Reducer determinism + replay==live, event-log
      seq/replay/gap-free handoff, `classifyRateLimit`, SessionManager guards.
- [ ] **Server integration tests.** Stand up the WS/REST server in-process and
      drive subscribe → replay → live over a real socket (no live `claude`).
- [ ] **Reducer tests reused by clients.** The web/mobile views fold the same
      reducer; a light render smoke test would guard the UI layer too.

## 1. Verify on real hardware (not yet done)

- [ ] **Full stack once through.** Start the daemon (`pnpm --filter @crc/daemon dev`)
      and the web app (`pnpm --filter @crc/web dev`), connect, create a session,
      send a prompt, watch it stream. See [SETUP.md](./SETUP.md).
- [ ] **Take-control handoff.** Open the web app in two browser windows and
      confirm the lock hands off and viewers see the stream live.
- [ ] **Reconnect resilience.** Kill/restart the daemon mid-session; the client
      should replay and catch up with no "exit and rejoin".
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

- [ ] **Live session-list updates.** The session list is REST-polled every 4s; a
      dedicated `sessions` WS subscription would make it instant.
- [ ] **Stop/interrupt button.** The Agent SDK supports `interrupt()`; wire a
      "stop turn" control.
- [ ] **Delta-event compaction.** Token deltas are persisted per-token for
      faithful mid-turn replay; compact them once the final block lands to keep
      the event log small.
- [ ] **Usage reader org-id auto-resolve.** Today `orgId` is supplied manually in
      `usage-accounts.json`; could auto-resolve it from the session key.

## 4. Known fragilities

- The claude.ai usage endpoint is undocumented/reverse-engineered — the usage-%
  reader may need a tweak if Anthropic changes it (the rate-limit trigger does
  not depend on it).
- Multi-account rotation requires `cswap` installed with accounts added; the
  daemon degrades gracefully (no accounts → feature simply hidden).
