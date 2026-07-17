# Setup & deployment

How to run the daemon on your homelab and reach it securely from your other
devices.

## Prerequisites

- Node 20+ and `pnpm` (via `corepack enable pnpm`)
- The `claude` CLI installed and **logged in** on the homelab box (the daemon
  uses your existing Claude Code auth via the Agent SDK)
- Your git repos sitting under one folder (e.g. `~/coding`)

## 1. Install & build

```bash
git clone <this-repo> && cd claude-remote-control
pnpm install
pnpm build          # compiles protocol + daemon (+ web) to dist/
```

## 2. Configure

```bash
cp .env.example .env
pnpm --filter @crc/daemon cli token   # prints a strong token
```

Paste that token into `.env` as `CRC_AUTH_TOKEN`, and set `CRC_REPOS_ROOT` to
your projects folder. Leave `CRC_HOST=127.0.0.1` — we expose it over Tailscale
in step 4 rather than binding to the network directly.

Quick sanity check:

```bash
pnpm --filter @crc/daemon cli repos   # should list your repos
```

## 3. Run as an always-on service (pm2)

pm2 is already how you run other homelab services:

```bash
pnpm build
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # survive reboots (follow the printed instruction)
pm2 logs crc-daemon
```

For local development instead, `pnpm --filter @crc/daemon dev` (auto-reloads).

## 4. Reach it from anywhere with Tailscale

The daemon stays bound to loopback; Tailscale exposes it **only to your own
devices**, encrypted end-to-end, with no ports opened to the internet.

Install Tailscale on the homelab and each client device, then `tailscale up`.

### Recommended: `tailscale serve` (gives you HTTPS + WSS)

```bash
# On the homelab, proxy tailnet HTTPS -> the local daemon:
tailscale serve --bg 4517
tailscale serve status     # shows your https://<machine>.<tailnet>.ts.net URL
```

Now every device on your tailnet can reach
`https://<machine>.<tailnet>.ts.net`. HTTPS matters: the mobile app wants a
secure origin, and `wss://` comes for free. WebSocket upgrades pass through
`tailscale serve` unchanged.

### Alternative: bind to the tailnet directly

If you'd rather not use `tailscale serve`, set `CRC_HOST=0.0.0.0` (or your
`100.x.y.z` tailnet IP) in `.env`. A token is then **required** — the daemon
refuses to start on a non-loopback host without one (override only with
`CRC_ALLOW_INSECURE=1`, not recommended). You'll be on `http://…:4517` (no TLS).

## 5. Connect a client

- **Web:** `pnpm --filter @crc/web dev` → open `http://127.0.0.1:5173`, and in
  the setup screen enter your daemon URL (the tailnet HTTPS URL) + token.
- Open a second browser/device to try the take-control handoff live.

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
