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

- **Docker + Docker Compose** on the host (recommended — see step 1), *or*
  Node 20+ and `pnpm` (via `corepack enable pnpm`) if you'd rather run it
  without Docker.
- The `claude` CLI installed and authenticated on the host either way — even
  the Docker container reuses it from there, since Claude Code auth isn't
  something a container can do in isolation. **Recommended:
  `claude setup-token`** — a long-lived token built for exactly this
  always-on-server case, so it won't go stale on you. Plain `claude login`
  also works (same subscription, no extra cost either way) and is fine to
  start with, but its browser-OAuth session **can expire on a long-running
  headless box** and need a fresh interactive re-login to fix — worth
  knowing if it's a homelab/VPS you're not sitting in front of. Either
  command works fine on a headless box with no local browser — both print a
  URL you can open from any device to complete it.
- Your git repos sitting under one folder on that same host (e.g. `~/coding`)

## 1. Install & build

### Docker (recommended)

```bash
git clone <this-repo> && cd claude-remote-control
```

That's it for this step — `docker compose up --build` (step 3) builds the
image for you.

**Sessions run inside this container**, not on the host — so a session's own
Bash tool calls only have whatever CLI tools the `Dockerfile`'s `runtime`
stage installs (currently `git`, plus `uv`/`claude-swap` if you set those up
— see [Multi-account usage rotation](#multi-account-usage-rotation-optional)
— and `python3`). If a session hits `<tool>: command not found` for something
else (`jq`, `ripgrep`, ...), that's this: add it to the `apt-get install`
line in the `runtime` stage and rebuild, the same fix as for `python3`. It
isn't enough that the tool is installed on the host — only what's in this
image is visible inside the container.

### Without Docker

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
on first boot (`pnpm --filter @crc/daemon cli token`, or for Docker,
`docker compose exec daemon node dist/cli.js token`, shows whichever one is
active). Set it yourself only if you want to choose the value.

`CRC_REPOS_ROOT` defaults to `~/coding` for the non-Docker path — only
uncomment it if your repos live somewhere else. **For Docker, uncomment it
and set an absolute path** — it's what gets mounted into the container, so
it can't fall back to a default the way the bare-metal daemon can.

Leave `CRC_HOST=127.0.0.1` — we expose it over Tailscale in step 4 rather
than binding to the network directly. (`docker-compose.yml` sets this to
`0.0.0.0` *inside the container only*, which is what makes Docker's own port
publishing work — the port it publishes to the host is still loopback-only,
so this doesn't change your actual exposure. Nothing to touch here.)

Each session that has been prompted keeps one live `claude` process running
between turns (that's what lets background agents keep working after their
turn ends and still ask you for tool approvals). Budget roughly 1 GiB of RAM per
live process. `CRC_LIVE_IDLE_MINUTES` (default 60) controls how long a process
with nothing running — no turn, no background agent, no pending approval — is
kept before the daemon closes it; the conversation itself is never lost, the
next prompt simply resumes it in a fresh process. Set it to `0` to keep
processes until archive/delete/shutdown if you have the memory to spare.

Quick sanity check:

```bash
pnpm --filter @crc/daemon cli repos   # should list your repos
# or, for Docker:
docker compose run --rm daemon node dist/cli.js repos
```

## 3. Run as an always-on service

### Docker (recommended)

```bash
docker compose up -d --build
docker compose logs -f daemon
```

Brings up two containers: **`daemon`** (required) and **`web`** (optional —
the actual UI, statically built and served by nginx, so it's reachable from
any device without anyone needing a local dev environment or the repo
cloned — the Docker equivalent of the `crc-web` pm2 process below). Reuses
your host's `claude` session (mounted from `~/.claude`) and your repos
(mounted from `CRC_REPOS_ROOT`) — see `docker-compose.yml` for exactly what's
mounted and why. Re-run the same command any time you pull new code;
`restart: unless-stopped` means both survive a host reboot with no extra
step. Only `daemon` is required if you'd rather just run
`pnpm --filter @crc/web dev` locally instead — comment out the `web` service
in `docker-compose.yml` if you don't want to build/run it at all.

### Without Docker (pm2)

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

The daemon stays bound to loopback — directly, or via Docker's published
port, which is loopback-only either way (see step 3). Tailscale exposes it
**only to your own devices**, encrypted end-to-end, with no ports opened to
the internet.

Install Tailscale on the host and each client device, then `tailscale up`.
`tailscale serve`/`status` need root by default — run
`sudo tailscale set --operator=$USER` once so you don't need `sudo` for
every command after.

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

**If you already run a reverse proxy (Caddy, Traefik, nginx…) on this host
for other `.internal`/local sites, check it first.** `tailscale serve`
claims `<tailnet-ip>:443` directly — if your reverse proxy is *also* bound
to that address (common if it fronts other homelab services over Tailscale
too), the two silently collide: one loses the port, often invisibly enough
that Docker still reports the container "Up" with its port publish quietly
unattached. The symptom is broken TLS on your *other*, unrelated sites
(`SSL_ERROR_INTERNAL_ERROR_ALERT` and similar), not an obvious "address
already in use" error, so it's easy to chase the wrong cause. Check first
with `tailscale serve status`; undo with `tailscale serve --https=443 off`
(or `tailscale serve reset` to clear everything if it's gotten tangled). If
your reverse proxy already owns that IP, point *it* at the daemon instead of
running `tailscale serve` at all — see
[Advanced: other networking options](#advanced-other-networking-options)
below.

### Alternative: bind to the tailnet directly

If you'd rather not use `tailscale serve`, set `CRC_HOST=0.0.0.0` (or your
`100.x.y.z` tailnet IP) in `.env`. The token requirement doesn't change either
way — the daemon always has one, auto-generated if you didn't set one — but
you'll be on `http://…:4517` with no TLS, so the token travels in plaintext on
your tailnet instead of over HTTPS.

### Advanced: other networking options

Tailscale is the recommended and only *supported* way to reach the daemon
remotely. The options below are for less common setups people sometimes ask
about — not first-class, but documented so you're not guessing.

**Reverse proxy (Caddy) for a real domain.** A separate concern from remote
access: if you'd rather use a domain you own than a `*.ts.net` tailnet
address, put [Caddy](https://caddyserver.com) in front — free automatic HTTPS
in about two lines (if Caddy itself runs in a container, see the networking
note below first):

```
example.com {
    reverse_proxy 127.0.0.1:4517
}
```

This is orthogonal to Tailscale, not a replacement for it — Caddy handles the
domain/TLS, Tailscale (or your firewall) still decides who can reach the port
at all. Traefik works the same way if you already run it for other
containers and want Docker-label auto-discovery instead of a Caddyfile.

**Already running Caddy for other internal sites (e.g. `*.internal`) bound to
your tailnet IP?** Don't *also* run `tailscale serve` on that IP — see the
warning in step 4, they'll fight over port 443. Add the daemon — and, if
you're running the optional `web` container from step 3, the actual UI too
— as two more sites in your existing Caddyfile, the exact same shape as
every other site already in it, reusing whatever internal CA you already
have trusted rather than `tailscale serve`'s own cert:

```
crc.your-homelab.internal {
    reverse_proxy 127.0.0.1:4173   # the actual web UI
    tls internal
}

crc-api.your-homelab.internal {
    reverse_proxy 127.0.0.1:4517   # the daemon (API only — no page to browse)
    tls internal
}
```

In the UI's own Setup screen, the Daemon URL is
`https://crc-api.your-homelab.internal`. Two plain `reverse_proxy` blocks —
nothing CRC-specific about them, so they slot into an existing Caddyfile the
same way any other two-container app would. (If you'd rather have just one
hostname, Caddy can also split by *path* instead of subdomain —
`handle_path /api/*` routing to the daemon, everything else to the UI, with
`https://crc.your-homelab.internal/api` as the Daemon URL — but that trades
one DNS entry for a bit of Caddyfile that looks different from your other
sites, so the two-hostname version above is the better default if your
Caddyfile is otherwise this uniform.)

You'll never actually browse to `crc-api.your-homelab.internal` in a tab —
it's not a page, just the address the UI's own JavaScript calls in the
background, same as `api.example.com` on any site with a separate frontend
and backend. It still needs to be a *real, trusted HTTPS* address though,
not just a bare `IP:port`: once the UI is loaded over HTTPS, browsers flatly
refuse to let its JS call anything served over plain HTTP ("mixed content"
— not configurable, not a CRC thing, just how browsers work), so the daemon
has to be HTTPS too, with a cert the browser actually trusts. Routing it
through Caddy with `tls internal` is what gets you that.

**Pairing an Android phone against a `tls internal` address?** A browser on
that phone will happily prompt to trust the cert (or already does, if you
installed your CA there for other `*.internal` sites). The CRC app itself
also trusts user-installed CAs, not just system ones — same accommodation
self-hosted apps like Immich make for exactly this setup. But that trust is
still per-device: install your reverse proxy's root CA cert via Android
Settings → Security → "Install a certificate" → CA certificate (however
you already did it for your browser) before pairing, or the app's own
network calls will fail with something like "Network request failed" even
though the daemon is perfectly reachable.

**If that Caddy runs in its own container** (common — one shared
`docker-compose.yml` fronting several homelab services), the snippets above
will 502: `127.0.0.1` inside Caddy's container means *itself*, not your
host, so it has no route to either port at all. Change the `reverse_proxy`
lines above to `crc-web:80` and `crc-daemon:4517` (container names instead of
`127.0.0.1`), then put both CRC containers on whatever Docker network Caddy
is already on — find that network's name with:

```
docker inspect <your-caddy-container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

Copy `docker-compose.override.yml.example` to `docker-compose.override.yml`
(gitignored — stays local to this host, so `git pull` never conflicts with
it) and set that network name in it. Compose merges an override file in
automatically, no extra flags — just `docker compose up -d` again.

**Headscale** is a self-hosted, open-source implementation of Tailscale's
coordination server — a drop-in alternative if you'd rather not depend on
Tailscale's hosted control plane (the WireGuard traffic itself is always
direct and encrypted either way). Same client setup on your devices, just
pointed at your own Headscale instance. Worth it only if you have a specific
reason to run your own control plane; Tailscale's free tier (100 devices) is
the easier default for most people.

**Exposing the daemon directly to the public internet — not recommended.**
Skipping Tailscale/a VPN and port-forwarding or reverse-proxying the daemon
straight onto the open internet is possible, but this daemon spawns real
processes with real filesystem/code-execution access — closer in blast
radius to exposing SSH than to exposing a blog. The bearer token becomes the
*only* thing standing between the open internet and that access (see
[Security model](#security-model-single-user-v1) below), and there's no rate
limiting or other hardening built in for this scenario. If you do it anyway:
always put TLS in front (Caddy, above), set your own strong `CRC_AUTH_TOKEN`
rather than relying on the auto-generated one, and treat that token with the
same care as an SSH private key.

## 5. Connect a client

- **Web:** `pnpm --filter @crc/web dev` → open `http://127.0.0.1:5173`, and in
  the setup screen enter your daemon URL (the tailnet HTTPS URL) + token. (Or,
  if you set up the always-on web container/`crc-web` pm2 process in step 3,
  just open `http://<tailnet-ip>:4173` from any device instead.)
- Open a second browser/device to try the take-control handoff live.

### Pairing additional devices (QR code)

Once one client is connected, don't retype the URL and token on the next one.
Any connected web or Android client has a **"Pair a device"** button that shows
a QR code encoding its own working `{ baseUrl, token }`. On the device you're
adding, use **"Scan QR code"** on the Setup screen (Android) instead of typing
— it runs the same connectivity test either way, so a stale or wrong QR still
fails safely rather than "connecting" silently.

### Alternative bootstrap: `crc init`

The flow above assumes you open the web app first and type the daemon URL +
token in once. If you'd rather skip that and onboard your **phone** directly
— no browser needed, no typing a 43-character token on a phone keyboard —
run this from the daemon host instead:

```bash
pnpm --filter @crc/daemon cli init
# or, for Docker:
docker compose exec daemon node dist/cli.js init
```

Reports your resolved token and the repos found under `CRC_REPOS_ROOT`,
detects Tailscale and offers to run `tailscale serve` for you (printing the
exact fix if the operator isn't set yet — see step 4), then prints a pairing
QR straight to the terminal — scan *that* with the phone's **"Scan QR
code"** and it's connected, no other device involved. This only helps the
phone specifically: the web app and VS Code have no camera scanner, so they
still need the manual URL + token entry above (or scanning a QR shown by
whichever device you bootstrap first).

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

**"Unable to load script" / the app can't reach Metro?** This is a plain
Metro-bundler connectivity problem, nothing CRC-specific. Metro defaults to
advertising your Mac/PC's Wi-Fi IP (e.g. `192.168.1.104:8081`); if the phone
can't actually reach that (different network, client isolation on the
router, or it's plugged in via USB with Wi-Fi off), the bundle fetch just
fails. Easiest fix if you have a USB cable handy — it sidesteps network
topology entirely:

```bash
adb devices                              # confirm the phone shows up
adb reverse tcp:8081 tcp:8081             # map the phone's localhost:8081 to this Metro
REACT_NATIVE_PACKAGER_HOSTNAME=localhost npx expo start --dev-client   # from apps/mobile
```

That makes Metro advertise `localhost:8081` instead of the LAN IP, which the
`adb reverse` tunnel actually maps. Reopen the app on the phone (or press
`a` in the Metro terminal) afterwards. No Wi-Fi/Tailscale/router config
required either way.

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

**Docker:** the account list and usage % stay invisible in every client until
`cswap` is actually reachable *from inside the `daemon` container* — `GET
/accounts` calls `cswap list` unconditionally (not just when rotation is
enabled), and the UI shows nothing at all when that comes back empty. `cswap`
is a pipx-managed Python package on the host, so — unlike RTK, which is a
single binary you can bind-mount straight into the container (see the RTK
section below) — bind-mounting just its `~/.local/bin/cswap` shim doesn't
work: that shim's shebang points at a host-only venv path
(`~/.local/share/pipx/venvs/claude-swap/bin/python`) that doesn't exist in the
container. This repo's `Dockerfile` installs `cswap` directly into the image
instead, so a rebuild is all `cswap` itself needs:

```bash
docker compose up -d --build
```

`cswap`'s own account/credential state lives outside `~/.claude` though — in
`${XDG_DATA_HOME:-~/.local/share}/claude-swap/` on Linux — so if you already
registered accounts with `cswap` on this host before adding Docker, also
bind-mount that directory (not read-only — `cswap` writes back to it on every
switch/refresh) via `docker-compose.override.yml`; see the commented block in
`docker-compose.override.yml.example`. Confirm it's working with
`docker compose exec daemon cswap list --json`.

**Only mount that one directory.** `cswap` also recognizes a legacy
`~/.claude-swap-backup` path from older versions; if that path doesn't
already exist with real data on your host, don't mount it — an empty
`~/.claude-swap-backup` (which Docker will silently create on the host the
moment you *do* bind-mount a path that isn't there yet) makes `cswap` see
both a legacy and a new backup location at once and refuse to run at all
(`MigrationError: Both legacy ... and new ... backup paths exist`), rather
than guessing which one is authoritative.

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
  the swap lands at a clean boundary. Idle live `claude` processes are recycled
  after a swap (a running one may cache the old account's credentials) and the
  next prompt resumes the same transcript in a fresh process.
- **Fail-safe:** if usage is unavailable or a check errors, it holds rather than
  switching blind.
- All clients show a live per-account usage strip and a manual **Switch** button.

**Update cadence** — three independent timers, no manual refresh:
- The web/phone usage strip polls `GET /accounts` every **15s**.
- The daemon caches each account's usage for **15s** before re-hitting
  claude.ai, so a poll often serves a cached value instantly. Net effect: the
  % you see is at most ~30s stale.
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

- **Paste (recommended — works everywhere, including a headless daemon).**
  The web UI's "Connect usage %" panel has a **How to find the key** link
  that walks through this inline; the steps are:
  1. Open `https://claude.ai` in any browser (your phone, laptop, whatever —
     it doesn't need to be on the daemon host) and make sure you're signed in.
  2. Open DevTools: `Cmd+Option+I` on Mac, `F12` on Windows/Linux, or
     right-click → Inspect.
  3. Go to the **Application** tab (Chrome/Edge) or **Storage** tab (Firefox).
  4. In the left sidebar expand **Cookies** → `https://claude.ai`.
  5. Find the row named `sessionKey` and copy its **Value** — it starts with
     `sk-ant-sid…`.
  6. Paste that value into the panel (or the Claude Usage app has the same
     cookie, if you already use that).

  This is the only option that works if the daemon runs on a headless/
  terminal-only box (e.g. a homelab server with no display) — guided login
  below needs an actual display to render the browser and will fail there
  with a Playwright/Chrome launch error.
- **Phone (native login):** a WebView opens claude.ai; sign in and the session
  cookie is captured automatically (no Cloudflare challenge — it's a real
  browser session, not an automated one). Needs a custom dev build — see the
  mobile note below (you already build outside Expo Go for push).
- **Guided browser login (needs a display on the daemon host).** The daemon
  opens a real, headful browser on whatever machine it's running on — not
  necessarily your Mac or phone, but wherever `crc-daemon` is — and reads the
  session cookie once you sign in there. Requires Playwright on the daemon
  host: `pnpm --filter @crc/daemon add playwright` (reuses your installed
  Chrome via `CRC_USAGE_LOGIN_CHANNEL=chrome`, so no 150 MB download). You can
  also run it headless of the app with `pnpm --filter @crc/daemon exec crc
  usage login`.

On the CLI, the same two steps: `crc usage orgs <sessionKey>` lists your orgs
with their usage, then `crc usage connect <sessionKey> <orgId>` persists the
one you picked.

**Picked the wrong org?** Every client shows a small **✕** next to any account
with a connected usage key — tap it to stop tracking that account (a
confirmation prompt guards against misclicks), then reconnect and pick the
right org. On the CLI: `crc usage disconnect <email>`.

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

## Previewing what a session builds (optional)

Sessions run inside the daemon container, so a dev server they start is
unreachable by default — not because of the filesystem, but because nothing
routes to that port. Without this, every time Claude builds something you can
look at, someone has to hand-make an SSH tunnel.

If you already reverse-proxy CRC (§ Advanced networking), the tidiest fix is a
wildcard host that maps a port onto a hostname. With Caddy on the same Docker
network as the daemon:

```caddyfile
*.preview.internal {
	@port header_regexp pport Host ^p([0-9]{2,5})\.preview\.internal$
	handle @port {
		reverse_proxy crc-daemon:{re.pport.1}
	}
	handle {
		respond "Use https://p<port>.preview.internal" 404
	}
	tls internal
}
```

A server on port 3000 is then `https://p3000.preview.internal`, on 5173
`https://p5173.preview.internal`, and so on — any port, no configuration per
project. Nothing is published to the host, so a port already taken there (say
another service on 3000) can't clash: this reaches the container's own port
space. Requires a wildcard DNS entry for `*.internal` (Tailscale split DNS or
your own resolver) pointing at the proxy.

Two things sessions must get right, which is why it's worth putting in the
`CLAUDE.md` inside the `~/.claude` you mount into the daemon:

- **Bind `0.0.0.0`,** not localhost — Docker networking can't reach the
  container's loopback (`next dev -H 0.0.0.0`, `vite --host`).
- **Pick an unlikely port,** since two sessions running at once can collide
  with each other even though the host can't.

**What this exposes.** Any port inside the daemon container becomes reachable
on your private network without authentication. The daemon's own API stays
token-protected, but anything a session starts is open to devices on that
network — fine for a personal tailnet, not something to put on the internet.

## Pushing to GitHub (optional)

Sessions run **inside the daemon container**, which has no GitHub login of its
own. So Claude can `git commit` in a session's worktree but `git push` fails
with `could not read Username for 'https://github.com'` — your host's
credentials aren't visible across the container boundary.

The image ships the GitHub CLI and already wires it up as git's credential
helper. All that's missing is authentication. Two ways to supply it:

**Share the login your host already has.** Run `gh auth login` on the daemon
host once (`gh auth status` to check), then mount its config into the
container — in `docker-compose.override.yml`, under the daemon service:

```yaml
    volumes:
      - ${HOME}/.config/gh:/root/.config/gh:ro
```

Then `docker compose up -d --build daemon`. Sessions can now push, and use
`gh` for pull requests and issues, exactly as on the host. Read-only so a
session can't log your host out; gh may warn when it can't write its state.

**Be aware what this grants.** Every session gets your full GitHub reach —
every repo and org that login can touch, not just the one it's working in.
That's the same trust level CRC already assumes (a session can run arbitrary
code on the host), but it now extends to your remote repositories.

**Or give it a narrower token.** For a smaller blast radius, create a
fine-grained personal access token limited to specific repositories with
Contents: read and write, put it in `.env` as `GITHUB_TOKEN`, and add to the
daemon service in `docker-compose.override.yml`:

```yaml
    environment:
      GIT_CONFIG_COUNT: "1"
      GIT_CONFIG_KEY_0: credential.https://github.com.helper
      GIT_CONFIG_VALUE_0: '!f() { test "$1" = get && echo username=x && echo "password=${GITHUB_TOKEN}"; }; f'
```

The doubled `$` are required — they stop Compose interpolating the values
itself so git's shell expands them at run time. No rebuild needed, but
sessions get no `gh` command.

## RTK token-savings support (optional)

If you use [RTK](https://github.com/rtk-ai/rtk) locally, the daemon can rewrite
Bash commands through it too — same 60-90% output-shrinking, applied to every
session CRC runs.

Normal `rtk init -g` doesn't apply here: it wires up RTK via Claude Code's
`settings.json` hook mechanism, but CRC strips any `hooks` a repo's own
`.claude/settings.json`/`settings.local.json` defines before every turn (see
[MCP servers](#mcp-servers-optional) below for why that's a repo file, not an
SDK isolation flag). Instead, set:

```
CRC_ENABLE_RTK=1
```

This calls RTK's own `rtk hook claude` binary in-process for every Bash tool
call, the same one `rtk init -g` would otherwise install. **Install `rtk` on
the daemon host** (not your laptop/phone) — that's where the `claude`
subprocess actually runs. If `rtk` isn't found or errors, the daemon fails
open: the command just runs unmodified, so a missing/broken install never
blocks a session.

If the daemon runs as a systemd/pm2 service with a stripped-down `PATH` that
doesn't include wherever `rtk` was installed (e.g. `~/.local/bin` via the
quick-install script), point at it directly instead of relying on PATH
lookup:

```
CRC_RTK_BIN=/home/you/.local/bin/rtk
```

Note that `CRC_RTK_BIN` only changes how the daemon invokes RTK's own `rtk
hook claude` binary to decide the rewrite — the rewritten Bash command that
actually runs afterward is just plain text RTK's hook produced (e.g. `rtk
find . -maxdepth 2 -type f`), with no path baked in. That bare `rtk` still
gets resolved via the shell's own `PATH` when the command executes, so the
directory `CRC_RTK_BIN` points at must ALSO be on `PATH` for this to work
end-to-end — otherwise the permission prompt shows the rewritten command
just fine (since that step uses `CRC_RTK_BIN` directly), but running it fails
with "rtk: not found" once approved.

**Docker is a different problem, not just PATH.** The container has its own
filesystem — `~/.local/bin/rtk` on the host doesn't exist inside it at all,
so `CRC_RTK_BIN` pointing at a host path will always `ENOENT` no matter what
you set. Install `rtk` on the host, then bind-mount that one binary into the
container at `/root/.local/bin/rtk` specifically — not an arbitrary path —
since that's the one directory the `Dockerfile` already adds to `PATH` (for
cswap; see its own comment there), which is exactly what the note above means
by "must ALSO be on PATH": add this under the `daemon` service in
`docker-compose.override.yml` (gitignored, stays local to this host; merge it
into the `daemon:` block if you already have one for reverse-proxy network
wiring, don't add a second file — Compose only reads one):

```yaml
services:
  daemon:
    volumes:
      - ${HOME}/.local/bin/rtk:/root/.local/bin/rtk:ro
      - ${HOME}/.local/share/rtk:/root/.local/share/rtk
```

`CRC_RTK_BIN` doesn't need to be set at all in this case — `/root/.local/bin`
is already on `PATH`, so the default (bare `rtk`) resolves correctly both for
the daemon's own hook invocation and for the rewritten command it produces.

The second line matters even if you don't care about `PATH`: RTK's own stats
(`history.db`, what `rtk gain` reads for the badge below) live under its XDG
data dir, not next to the binary. Without that mount, the container only has
that directory in its own writable layer — a plain `docker restart` leaves it
alone, but anything that recreates the container (`docker compose up --build`,
`down && up`, `--force-recreate`) wipes it back to zero. Bind-mounting the same
path the host's native `rtk` already uses fixes that, and also means the
container's usage and any host-native `rtk` usage share one running history.

Then `docker compose up -d` and confirm with
`docker compose exec daemon /root/.local/bin/rtk --version`. If that
fails with something other than "not found" (e.g. a missing shared library),
the host's `rtk` binary isn't compatible with the `node:20-bookworm-slim`
image's libc — install a build of `rtk` linked against a compatible libc, or
add an install step to the `Dockerfile` instead of bind-mounting.

**Seeing the savings:** once `CRC_ENABLE_RTK=1` is set, every connected client
shows a small rocket badge in the header (next to the accounts badge) with
RTK's own token-savings numbers for the daemon host — commands run, tokens
saved, average savings %, and the last 30 days. It's a thin read-only view
over `rtk gain --daily --format json`; the daemon computes nothing itself, so
`rtk gain` on the host and the badge always agree. The badge stays hidden
until `rtk` actually responds successfully, so a broken/missing install is
silent there too — check the daemon logs if you expect it to show up and it
doesn't.

## MCP servers (optional)

No CRC-side config needed — a repo's own `.mcp.json` (or user-level
`~/.claude.json` MCP config on the daemon host) connects automatically,
exactly like a local `claude` CLI session, since CRC's sessions load project
filesystem settings by default. Manage MCP servers the same way you would for
any Claude Code project: edit `.mcp.json` in the repo, or `claude mcp add` on
the daemon host.

The one thing CRC strips out of that same filesystem-settings loading is
`hooks` (see the RTK section above) — a repo's `.claude/settings.json` can
still define `mcpServers`, `permissions`, `statusLine`, etc.; only the
`hooks` key is removed, and only from the session's own worktree copy, never
your source repo.

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
- A repo's own `.claude/settings.json`/`settings.local.json` can't smuggle in
  a `PreToolUse`/`PostToolUse` command hook to get shell execution around the
  approval prompt — CRC strips the `hooks` key from both files, in the
  session's worktree, before every turn. This matters regardless of
  `CRC_FORCE_PERMISSION_PROMPTS`: a hook-defined command runs unconditionally,
  even when a tool call is denied, so it isn't something the permission
  system alone can catch.
