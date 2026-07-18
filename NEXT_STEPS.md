# Next steps

All six build steps and the multi-account rotation feature are implemented and
committed. The pure core now has a Vitest unit suite (`pnpm test`) — the
event-log→state reducer, the daemon event log, the rate-limit classifier, and
the SessionManager lock/single-writer invariants. The parts that need a browser,
VS Code, an Android device, or live-exhausted accounts still can't be exercised
in the build environment. This is the punch list to finish on real hardware,
plus deferred enhancements.

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
