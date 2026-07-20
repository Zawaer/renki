# Setup & deployment

How to run the daemon on an always-on host and reach it securely from your
other devices.

## Choosing a host

The daemon needs to run on a machine that's on 24/7 — sessions surviving a
closed laptop lid or a powered-off phone is the whole point, so it can't live
on the device you're driving it from. A **homelab box** and a **personal
VPS** work identically here — pick whichever you already have running. The
one thing that follows the host, not you: your repos and the `claude` CLI's
login need to actually live there (see below), not on your laptop.

## Prerequisites

- Node 20+ and `pnpm` (via `corepack enable pnpm`)
- The `claude` CLI installed and authenticated on the host (the daemon uses
  it via the Agent SDK). **Recommended: `claude setup-token`** — a long-lived
  token built for exactly this always-on-server case, so it won't go stale on
  you. Plain `claude login` also works (same subscription, no extra cost
  either way) and is fine to start with, but its browser-OAuth session **can
  expire on a long-running headless box** and need a fresh interactive
  re-login to fix — worth knowing if it's a homelab/VPS you're not sitting in
  front of. Either command works fine on a headless box with no local
  browser — both print a URL you can open from any device to complete it.
- Your git repos sitting under one folder on that same host (e.g. `~/coding`)

## 1. Install & build

```bash
git clone <this-repo> && cd claude-remote-control
pnpm install
pnpm build          # compiles protocol + daemon (+ web) to dist/
```

## 2. Configure

```bash
cp .env.example .env
```

`CRC_AUTH_TOKEN` is optional — leave it commented out and the daemon mints one
on first boot (`pnpm --filter @crc/daemon cli token` shows whichever one is
active, generating it if needed). Set it yourself in `.env` only if you want
to choose the value. `CRC_REPOS_ROOT` defaults to `~/coding`; only uncomment
it if your repos live somewhere else. Leave `CRC_HOST=127.0.0.1` — we expose
it over Tailscale in step 4 rather than binding to the network directly.

Quick sanity check:

```bash
pnpm --filter @crc/daemon cli repos   # should list your repos
```

## 3. Run as an always-on service (pm2)

pm2 is a solid fit for keeping this running in the background on a homelab
box or a VPS alike. `ecosystem.config.cjs` defines two processes:
**`crc-daemon`** (required) and **`crc-web`** (optional — the website itself,
served as a static build so it's reachable from any device without anyone
needing a local dev environment or the repo cloned).

```bash
pnpm build
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # survive reboots (follow the printed instruction)
pm2 logs crc-daemon
pm2 logs crc-web
```

`crc-web` runs `vite preview` over `apps/web/dist` on port **4173**, bound to
all interfaces — reachable at `http://<tailnet-ip>:4173` from any device on
your tailnet. Unlike the daemon, it doesn't need `tailscale serve`/HTTPS: it's
just static files, and a plain-HTTP page connecting to the daemon's `https://`
URL isn't a mixed-content problem (only the reverse direction is). Only
`crc-daemon` on its own is required if you'd rather just run
`pnpm --filter @crc/web dev` locally on whichever device you're using at the
moment (what the rest of this guide assumes).

To deploy a web change: `pnpm build` again, then `pm2 restart crc-web`.

For local daemon development instead of pm2, `pnpm --filter @crc/daemon dev`
(auto-reloads).

## 4. Reach it from anywhere with Tailscale

The daemon stays bound to loopback; Tailscale exposes it **only to your own
devices**, encrypted end-to-end, with no ports opened to the internet.

Install Tailscale on the host and each client device, then `tailscale up`.

### Recommended: `tailscale serve` (gives you HTTPS + WSS)

```bash
# On the host, proxy tailnet HTTPS -> the local daemon:
tailscale serve --bg 4517
tailscale serve status     # shows your https://<machine>.<tailnet>.ts.net URL
```

Now every device on your tailnet can reach
`https://<machine>.<tailnet>.ts.net`. HTTPS matters: the mobile app wants a
secure origin, and `wss://` comes for free. WebSocket upgrades pass through
`tailscale serve` unchanged.

### Alternative: bind to the tailnet directly

If you'd rather not use `tailscale serve`, set `CRC_HOST=0.0.0.0` (or your
`100.x.y.z` tailnet IP) in `.env`. The token requirement doesn't change either
way — the daemon always has one, auto-generated if you didn't set one — but
you'll be on `http://…:4517` with no TLS, so the token travels in plaintext on
your tailnet instead of over HTTPS.

## 5. Connect a client

- **Web:** `pnpm --filter @crc/web dev` → open `http://127.0.0.1:5173`, and in
  the setup screen enter your daemon URL (the tailnet HTTPS URL) + token. (Or,
  if you set up the always-on `crc-web` pm2 process in step 3, just open
  `http://<tailnet-ip>:4173` from any device instead.)
- Open a second browser/device to try the take-control handoff live.

### Pairing additional devices (QR code)

Once one client is connected, don't retype the URL and token on the next one.
Any connected web or Android client has a **"Pair a device"** button that shows
a QR code encoding its own working `{ baseUrl, token }`. On the device you're
adding, use **"Scan QR code"** on the Setup screen (Android) instead of typing
— it runs the same connectivity test either way, so a stale or wrong QR still
fails safely rather than "connecting" silently.

### VS Code extension

The extension embeds the same web UI in a panel; you configure the connection
in VS Code instead of the in-app Setup screen.

```bash
pnpm build                                  # builds web + copies it into the extension
```

Then, in VS Code:

1. Open the `apps/vscode` folder and press **F5** ("Run CRC Extension") — this
   launches an Extension Development Host window. (Packaging a `.vsix` is
   optional and needs `@vscode/vsce`; the dev host doesn't.)
2. In the dev-host window: set **`crc.daemonUrl`** in Settings, then run
   **"Claude Remote Control: Set Auth Token"** from the command palette.
3. Run **"Claude Remote Control: Open Panel"**. The token lives in VS Code's
   SecretStorage (never in `settings.json`), and file paths in tool calls become
   clickable — they open the file from the session's worktree in your editor.

### Android app (Expo)

```bash
pnpm --filter @crc/mobile start        # Metro; scan the QR with Expo Go (Android)
```

(That QR just loads the JS bundle — Metro's own dev-client QR, not the CRC
pairing one below.)

On the app's Setup screen, either **tap "Scan QR code"** and scan the pairing
QR from an already-connected client (see [§5](#pairing-additional-devices-qr-code)
above — fastest, no typing), or enter your daemon's **HTTPS** tailnet URL (use
`tailscale serve` — Android blocks plaintext HTTP by default in release builds)
and your token manually. Either way runs the same connectivity check before
saving. The phone gets a stable device id, so it keeps its place in the
take-control lock across restarts.

**Push notifications** (permission requests / turn completion while the app is
backgrounded) need a few extra one-time steps:

1. `cd apps/mobile && npx eas init` to create an EAS project, then put the
   printed id in `app.json` under `extra.eas.projectId`.
2. Remote push requires a **development build** (Expo Go no longer supports it):
   `npx expo run:android` (with a device/emulator + Android SDK) or
   `eas build --profile development --platform android`.
3. Launch that build, grant the notification permission — the app registers its
   Expo push token with the daemon (`POST /devices/push-token`). Now, when you
   send a prompt and background the app, you'll get a push if Claude needs a
   permission decision or the turn finishes. Tapping it opens that session.

Enable `CRC_FORCE_PERMISSION_PROMPTS=1` on the daemon so tool permissions
actually reach your phone instead of being auto-approved by the host's
allow-list.

## Multi-account usage rotation (optional)

If you have more than one Claude account, the daemon can automate the manual
"hit the limit → `cswap switch` → keep going" habit.

**Prerequisite:** install [`cswap`](https://github.com/realiti4/claude-swap),
then add each account with **whichever of the three credential kinds below
fits it** — CRC never distinguishes between them; it only ever calls
`cswap list` / `switch` / `switch-to`, so the choice per account is entirely
yours. Confirm they're registered with `cswap list --json`.

### Choosing how to add each account

| Kind | How to add it | Tied to | Notes |
| --- | --- | --- | --- |
| **Interactive login** | `claude login`, then `cswap add` (captures whatever account `claude` is *currently* logged into) | Your Pro/Max/Team subscription | The default, easiest path. Its OAuth session **can go stale on a long-running headless box** and need an interactive re-`claude login` to fix — `cswap list --token-status` shows expiry state if you're chasing this. |
| **Long-lived setup-token** | `claude setup-token` prints a token → `cswap add-token` (paste it, or pipe it: `claude setup-token \| cswap add-token -`) | Your Pro/Max/Team subscription — same billing, no extra cost | Anthropic's own fix for headless/server use: built specifically to **not** need the periodic browser-based refresh that trips up interactive-login sessions. If an account keeps expiring on your daemon, re-add it this way. |
| **Plain API key** | An Anthropic Console API key → also fed to `cswap add-token` | Nothing — pay-per-token API billing, no Claude.ai subscription involved | For accounts you'd rather keep entirely separate from any subscription/OAuth flow. |

All three coexist fine — mix and match per account in the same `cswap`
install. Rotation, usage %, and the take-control lock all work identically
regardless of which kind an account uses.

Then set in `.env`:

```
CRC_ACCOUNT_ROTATION=1
CRC_ROTATION_THRESHOLD=90        # switch at 90% of the 5h or 7d window
CRC_ROTATION_COOLDOWN_MINUTES=5  # anti-flip-flop
```

How it behaves:

- **Rate-limit trigger (works with any account type, incl. setup-tokens):** when
  a turn actually fails because the account hit its limit, the daemon switches
  to the other account and — by default — **retries the same prompt once** on
  the new account. An inline notice shows this in the conversation. Turn off
  the retry with `CRC_ROTATION_AUTORETRY=0`.
- **Proactive threshold trigger (needs usage data — see below):** if usage % is
  available, it also switches when the active account's 5h **or** 7d usage
  crosses the threshold and another account has headroom.
- **Never mid-flight:** it defers a proactive swap while any session is running
  a turn; the rate-limit swap happens *after* the failed turn ends. Either way
  the swap lands at a clean boundary, and resume-per-prompt continues context.
- **Fail-safe:** if usage is unavailable or a check errors, it holds rather than
  switching blind.
- All clients show a live per-account usage strip and a manual **Switch** button.

**Update cadence** — three independent timers, no manual refresh:
- The web/phone usage strip polls `GET /accounts` every **30s**.
- The daemon caches each account's usage for **25s** before re-hitting
  claude.ai, so a poll often serves a cached value instantly. Net effect: the
  % you see is at most ~55s stale.
- The **rotation threshold check** (decides whether to actually switch) runs on
  its own timer, `CRC_ROTATION_POLL_SECONDS` (default **60s**) — independent of
  how often a UI happens to be open and polling.
- If a claude.ai poll fails (hiccup, expired key), the last-known value is kept
  rather than the bar going blank.

### Seeing usage percentages (optional)

`cswap` can't report usage for accounts added via `add-token` (setup-tokens /
API keys — it makes no API calls for those). To always see 5h/7d %, give the
daemon a **read-only claude.ai session key** per account (the same credential
the macOS Claude-Usage-Tracker uses) — this is separate from your coding
setup-tokens and only ever reads usage. You never have to find an org UUID: the
daemon resolves the org **and** email from the key automatically.

**Easiest — connect from any client.** In the Accounts strip tap **Connect
usage %**. Three ways to get a session key, all landing on the same daemon
endpoint, followed by **one extra step: you pick which organization's usage
to track.** claude.ai accounts commonly have more than one org (e.g. an empty
personal org next to the one that actually carries your subscription), so the
daemon never guesses — it lists every org the key can see, with each org's
live usage, and you tap the right one.

- **Phone (native login):** a WebView opens claude.ai; sign in and the session
  cookie is captured automatically (no Cloudflare challenge — it's a real
  browser session, not an automated one). Needs a custom dev build — see the
  mobile note below (you already build outside Expo Go for push).
- **Mac (guided login):** the daemon opens a real browser on its host; sign in
  and it reads the cookie. Requires Playwright on the daemon host:
  `pnpm --filter @crc/daemon add playwright` (reuses your installed Chrome via
  `CRC_USAGE_LOGIN_CHANNEL=chrome`, so no 150 MB download). You can also run it
  headless of the app with `pnpm --filter @crc/daemon exec crc usage login`.
- **Paste (works everywhere):** copy the `sessionKey` (`sk-ant-sid…`) cookie
  from claude.ai DevTools (or from the Claude Usage app) and paste it.

On the CLI, the same two steps: `crc usage orgs <sessionKey>` lists your orgs
with their usage, then `crc usage connect <sessionKey> <orgId>` persists the
one you picked.

**Manual file (still supported).** Copy `apps/daemon/usage-accounts.example.json`
to your data dir as `usage-accounts.json` (gitignored) and fill in the
`sessionKey` **and** `orgId` for each account — get the `orgId` from
`crc usage orgs <sessionKey>` first, since the daemon won't auto-pick one.

The daemon fetches usage through a browser-fingerprinted HTTP client (claude.ai
puts this endpoint behind Cloudflare, which blocks a plain server-side
request), matches by email, and fills in the usage bars — and with real usage
available, the proactive threshold trigger works too. The rate-limit trigger
works fine even without any of this.

> **Mobile dev build:** the native login uses `react-native-webview` +
> `@react-native-cookies/cookies`, which need native code. Rebuild the dev
> client after installing: `pnpm --filter @crc/mobile exec expo prebuild` then
> `pnpm --filter @crc/mobile run android` (or `ios`). It won't work in Expo Go.

The daemon only ever asks `cswap` to change which account the **official** CLI
loads at startup — it never extracts or reuses a token. That's the mechanism
Anthropic has confirmed is within the Consumer Terms.

Pair this with `CRC_FORCE_PERMISSION_PROMPTS=1` if you want tool approvals to
reach your phone rather than being auto-allowed.

## Security model (single-user v1)

- **Tailscale (WireGuard)** is the network boundary — the daemon is never on the
  public internet, traffic is device-to-device encrypted.
- The **bearer token** is defense-in-depth on top, checked in constant time, so
  only your clients can drive sessions even within the tailnet.
- No third-party relay: prompts/data only ever go to Anthropic via the `claude`
  process the daemon runs locally.
- `CRC_FORCE_PERMISSION_PROMPTS=1` makes every gated tool ask the controller
  instead of relying on your machine's allow-list — worth enabling once you
  approve actions from your phone.
