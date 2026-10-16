# Homelab gateway (design draft)

Lets Renki sessions operate the homelab without root and without a free shell.
Nothing here is installed yet; this is the policy to review first.

## Shape

```
Renki container --(ssh, forced command, key without a shell)--> gateway (host, own user)
                                                                      |
                                      /etc/homelab-gateway/policy.yml (root-owned, read-only to the container)
                                      /var/log/homelab-gateway.log    (append-only audit)
                                      /etc/homelab-gateway/DISABLED   (kill switch: touch to refuse everything)
```

- The gateway user is **not** in the `docker` group (that is root-equivalent).
  The gateway process itself talks to Docker; sessions only ever name a verb and an app.
- The SSH key in the container is restricted in `authorized_keys` with
  `command="/usr/local/bin/homelab-gateway",restrict`, so it can run nothing else.
- Policy and gateway binary are root-owned. The container cannot edit either.

## Verbs

| Tier | Verb | Behavior |
|---|---|---|
| 0 read | `status [app]` | `docker ps`, health, uptime |
| 0 read | `logs <container> [--since 1h]` | tail only, size capped |
| 0 read | `top` | CPU/memory per container, `df`, biggest dirs |
| 0 read | `backup-audit` | containers/mounts not covered by a Backrest plan or exclude |
| 1 reversible | `deploy <app>` | `git pull --ff-only`, `docker compose up -d --build` in the app's own dir |
| 1 reversible | `restart <app>` | `docker compose restart` |
| 1 reversible | `builder-prune` | `docker builder prune -f` (cache only; images, volumes untouched) |
| 1 reversible | `caddy-reload` | validate Caddyfile, then reload; never restart |
| 2 approval | `rm-path <path>` | only inside an app's own dir, never inside `protected`; needs phone approval |
| 2 approval | `remove-container <name>` | stopped containers of `deploy` apps only |
| never | anything else | `down -v`, `volume rm`, `system prune`, `rm` outside policy, docker run/exec, shell |

## Policy

The implemented policy is `ops/homelab-gateway/policy.json` (plain JSON, so the gateway needs no
extra Python packages); the YAML below is the readable summary. v1 implements tiers 0 and 1.
Tier 2 verbs are refused until the approval flow below exists.

```yaml
# /etc/homelab-gateway/policy.yml
apps:
  deploy:            # tier 1 allowed without asking
    - talkoot
    - shopping-tool
    - scout-tool
    - meeting-app        # kuulo
    - otaindex
    - contacts           # about-me/contacts
    - sm-outreach-pipeline
    - ig-outreacher
    - claude-accounts
  deploy_detached:   # restart kills the calling turn, so run as a detached job
    - renki
  ask_first: []      # tier 1 verbs need phone approval
  read_only:         # status / logs only
    - immich
    - dawarich
    - obsidian-livesync
    - beszel
    - backrest
    - dnsmasq
    - caddy              # plus caddy-reload only
protected:           # no verb may touch these paths or containers, approval or not
  paths:
    - /home/zawaer/immich
    - /var/lib/docker/volumes
    - /home/zawaer/obsidian-livesync
    - /home/zawaer/backrest
    - /home/zawaer/screenpipe-archive
    - /home/zawaer/.ssh
  containers:
    - renki-daemon       # can only be redeployed via the detached verb
    - caddy
    - backrest
    - immich_*
    - dawarich_*
    - obsidian_livesync_couchdb
limits:
  logs_max_lines: 2000
  approval_timeout_seconds: 300
```

## Approval (tier 2)

The gateway never trusts the session. For a tier 2 verb it:

1. Writes the exact command and a one-line summary to its own pending queue.
2. Sends a push to the paired phone through the daemon's existing push channel.
3. Waits for an approval signed by the phone's device key (single use, 5 min, bound to
   that exact command). A session cannot produce it: the daemon's auth token is in the
   container-mounted `/data`, so the approval secret must live elsewhere
   (the phone's device key / a key the container never sees). **Open design point.**
4. No answer within the timeout means denied.

## What this does not cover

- Money and external services: handled by scoping credentials per project, not here.
- Data loss from an app's own bug: Backrest snapshots (see `docs` / Backrest plans).
- A compromised homelab host: the gateway is a guardrail for sessions, not a sandbox
  against root.
