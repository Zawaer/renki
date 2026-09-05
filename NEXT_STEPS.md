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

- [x] **Mobile UI redesign + composer/navigation/persistence fixes.** Done,
      across several rounds of real-device testing: mobile's whole visual
      language moved from a flat, sharp-cornered VS Code Dark+ mirror to a
      warmer, rounded palette + a shared `radius`/`softShadow` scale
      (`apps/mobile/src/theme.ts`), a floating pill composer, and proper
      drag-to-dismiss bottom sheets (`apps/mobile/src/components/Sheet.tsx`)
      replacing the model/effort/mode pickers' old tap-to-cycle chips and the
      attach menu's plain list. Real bugs found and fixed along the way:
      - A freshly-created session's composer went keyboard-dead until the
        session was reopened (an Android Modal→new-screen IME handoff plus
        the composer being needlessly non-editable pre-`isController`) — now
        always editable, `Keyboard.dismiss()` added before the handoff.
      - `Sheet`'s drag-to-dismiss silently did nothing (an ancestor
        `TouchableOpacity` swallow-wrapper was winning the touch-responder
        race against the drag), then a follow-up fix broke row taps entirely
        (claiming the responder on touch-*start* instead of on real
        movement) — both are now correctly resolved with a comment
        explaining why, so the bug class doesn't reappear.
      - Android hardware/gesture back exited the app from any screen instead
        of navigating up (`apps/mobile/src/App.tsx`'s `BackHandler`); sheets
        already close on back via `Modal`'s own `onRequestClose`.
      - The status bar/nav bar/root window background defaulted to white
        (visible as a flash on launch and on any native repaint, e.g. the
        keyboard resize) — fixed via a new config plugin
        (`plugins/withAndroidDarkChrome.js`) for the status bar/window
        background (no first-class Expo config key reaches those), and
        app.json's first-class `androidNavigationBar` key for the nav bar
        (Expo's own built-in prebuild mod already covers that one).
      - The Android keyboard resize was an abrupt jump instead of following
        the keyboard (no `KeyboardAvoidingView` support on Android) —
        smoothed with a `LayoutAnimation`, isolated in its own hook
        (`lib/useAndroidKeyboardResizeAnimation.ts`) since it's a known
        best-effort approximation, not a frame-perfect fix.
      - The composer's last-picked model/effort/permission-mode now persist
        per-device on both platforms (`lib/composerPrefs.ts` — localStorage
        on web, `expo-secure-store` on mobile; only permission mode
        persisted before). Shared resolver/validation logic and the Stats
        screen's formatting helpers moved into `@crc/client-core` so web and
        mobile can't drift apart on either.
      A `/security-review` pass on this whole range found no high-confidence
      issues; a `/simplify` pass found and fixed a handful of real ones
      (duplicated validation/formatting logic, a `PanResponder` rebuilt
      every render, dead prop-threading, two more sheet-shaped modals not
      yet using the shared `Sheet`) — see the commit history for specifics.
      Still open: the demo GIF and flipping the repo public (below), plus
      whatever the next round of device testing turns up.
- [x] **Mobile Stats screen.** Done: `apps/mobile/src/screens/StatsView.tsx`,
      reachable from a stats-chart icon next to the new gear icon on the
      session list — a mirror of web's `StatsView.tsx` (same `/stats` +
      `/rtk/gain` REST calls, same lifetime tiles, by-repo/daily/monthly
      token+cost+wait-time charts, and the RTK-savings section when
      `CRC_ENABLE_RTK` is on). Two adaptations for touch/narrow-screen: web's
      hover tooltips on each bar become tap-to-reveal (a bar chart column is a
      `TouchableOpacity` that shows its tooltip text below the chart until
      tapped again), and its side-by-side chart grid stacks into a single
      column. The "view as table" toggle per section is a horizontally
      scrollable fixed-width-column view (`SimpleTable`) standing in for
      HTML's `<table>`. Added `chartInput`/`chartOutput` to
      `apps/mobile/src/theme.ts`, matching web's `--crc-chart-input`/`-output`
      hex values exactly, since no chart colors previously existed on mobile.
      Verified with `tsc --noEmit` across the whole repo and an
      `expo export --platform android` bundle build; not yet exercised on a
      real device/simulator — same open "Android app" hardware-verification
      item as the Settings screen above.
- [x] **Mobile Settings screen.** Done: `apps/mobile/src/screens/Settings.tsx`,
      reachable from a gear icon on the session list (replacing the header's
      old standalone "Pair a device"/"Disconnect" links), mirroring web's
      `Settings.tsx` — device name, connection info (daemon URL + token
      show/hide), full account management (switch active account, connect/
      disconnect usage tracking, add a coding account via `cswap add-token`,
      auto-rotation enable + threshold), QR pairing, and disconnect. Before
      this, mobile's one-time pre-auth `Setup` screen was the only place any
      of this showed up, with no way back in short of clearing the app's
      storage; account management was previously read/switch-only via the
      session-list's compact `AccountsBar` (no way to add an account or
      configure rotation from the phone). `Meter`/`ExtraUsageMeter` in
      `AccountsBar.tsx` were made self-contained (own inline styles instead of
      the parent screen's `StyleSheet`) so `Settings.tsx` could reuse them
      directly, same as web's `Settings.tsx` importing them from its own
      `AccountsBar.tsx`. Verified with `tsc --noEmit` across the whole repo
      and an `expo export --platform android` bundle build (catches Metro
      resolution errors); not yet exercised on a real device/simulator — that
      falls under the open "Android app" hardware-verification item above.
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

- [x] **One long-lived `claude` process per session (2026-09-05).** Replaced
      resume-per-prompt (a fresh `query()` per turn) with
      `apps/daemon/src/claude/liveSession.ts`: one process per session whose
      input stream never closes, fed one serialized prompt at a time by
      `SessionManager`'s existing FIFO queue. Why: the SDK closes the child's
      stdin as soon as the first `result` arrives
      (anthropics/claude-agent-sdk-typescript#376), which permanently broke
      every permission-gated tool call from a background Agent-tool task once
      its spawning turn ended — so background agents never really worked
      through CRC. Verified against the real CLI with a scripted smoke test:
      two turns share one process and session id; a background agent spawned
      in turn 1 kept running through turn 2 and, 24 s after both turns ended,
      its Write permission request reached the resolver and the file landed;
      its `task_notification` arrived while idle; and the CLI then started an
      unprompted turn to report the result — modeled as an "auto turn" with a
      synthetic `auto_<turnId>` promptId that flips the session busy/idle
      around it and drains anything queued behind it. Subagent output arriving
      turns later is routed to the turn holding its Task block via a
      tool_use→turn map. Processes close on archive/delete/shutdown, after an
      account switch (idle ones only — a running process may cache the old
      credentials), and after `CRC_LIVE_IDLE_MINUTES` (default 60) of true
      idleness. The RAM ceiling that originally motivated resume-per-prompt
      (~1 GiB/process) is now a config knob instead of an architecture.
      Follow-ups worth doing on real hardware:
      - **Resume across a restart after queued messages.** Upstream #67 (queued
        streaming-input messages missing from the CLI's transcript) is still
        open; CRC's own event log is complete regardless, but a session resumed
        after a daemon restart could see Claude's history minus those user
        turns. Prompts are only ever sent one at a time here, so this may not
        bite at all — confirm with a real restart mid-conversation.
      - [x] **Mid-turn steering (2026-09-05, same day).** A prompt sent while a
        turn is in flight is now pushed straight into the running process
        (`LiveClaudeSession.steer`, chosen over the queue in
        `SessionManager.submitPrompt` whenever the live process reports a turn
        running). Probed against the real CLI first: the message is picked up
        at the next tool-call boundary and answered inside the same turn,
        which ends with ONE `result` — and the CLI neither echoes the message
        back nor sets `result.user_message_uuid` to anything we sent, so there
        is no per-message ack to build on. Protocol therefore grew three
        things: `prompt_submitted.steered`, a new `turn_started` event
        (`trigger: prompt | background_task | auto`, emitted the moment a
        turnId exists), and `turn_result.promptIds` (every prompt the turn
        answered). The reducer pins a steered prompt INSIDE the running turn
        after the block that was current when it landed (`TurnView.
        steeredPrompts`) rather than appending it after the turn, so the
        transcript reads in real order; web + mobile render it there with a
        "picked up mid-turn" caption, and unprompted turns get a header from
        `turnTriggerLabel` ("Background agent finished — Claude's follow-up"
        / "Claude continued on its own"). The FIFO queue survives only as the
        fallback for the brief windows where the session is busy but no live
        turn can take a message (spawn in progress, account-switch retry).
        Usage pattern this unlocks: while a long task runs, type "also, in a
        background agent, do Y" — it starts seconds later, no second worktree.
        A dedicated "run in parallel" composer toggle was considered and
        dropped: it would only save typing that one phrase.

## 4. Known fragilities

- **Per-session git worktrees + the `crc merge` conflict flow may not scale to
  frequent conflicts.** Today a merge conflict spawns exactly one Claude
  session (unattended, auto-approved) pre-loaded with the conflicted worktree
  to resolve it serially (`apps/daemon/src/sessions/mergeFlow.ts`,
  `apps/daemon/src/git/merge.ts`). If parallel worktree branches on the same
  repo start conflicting often enough that this becomes a bottleneck, worth
  exploring a multi-agent orchestration approach instead — e.g. fan out
  independent agents per conflicted file/hunk (or per competing branch) and
  have them resolve concurrently rather than one bot session working through
  every conflicted file in sequence. (Since 2026-09-05 background agents
  actually survive their turn — see § 3 — so fan-out inside one session is now
  a real option rather than a hypothetical.)
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
