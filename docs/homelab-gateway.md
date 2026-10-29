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
| 2 approval | `create-repo <name> [--public]` | an empty GitHub repo under the policy's owner, private unless `--public`; refuses names that exist |
| never | anything else | `down -v`, `volume rm`, `system prune`, `rm` outside policy, docker run/exec, shell |

## Policy

The implemented policy is `ops/homelab-gateway/policy.json` (plain JSON, so the gateway needs no
extra Python packages); the YAML below is the readable summary. Tiers 0, 1 and 2 are implemented.

```yaml
# /etc/homelab-gateway/policy.yml
apps:
  deploy:            # tier 1 allowed without asking
    - talkoot
    - pihi
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

`rm-path` and `remove-container` never run on a session's say-so.

1. The gateway checks the request against the policy first (only inside a deployable app's
   own folder, never `.git`, never a protected path, no symlinks or `..`; only *stopped*
   containers of deployable apps) and writes its **own** summary: what, how many files,
   how big. Nothing a session wrote is shown to you.
2. It stores only the SHA-256 of a one-time token and pushes the token itself to your
   phone through Expo, straight from the gateway. The daemon is not on this path.
3. Your phone answers the approval service (`https://approvals.internal`, a small service
   on the host behind Caddy) with that token. First answer wins; a request expires after
   5 minutes (no answer = denied); five wrong tokens deny it.
4. Only on "approve", and only if nothing changed meanwhile (the checks run again), the
   gateway runs one fixed command: `rm -rf --one-file-system -- <path>` or `docker rm <name>`
   (never `-v`, so volumes are kept).

**Why a session cannot approve itself.** Sessions run as root next to the daemon and can
read the daemon's token and database. The one-time token only ever exists in the
gateway's memory and in the push payload; the approval file holds just its hash. A session
can reach the approval service's port but can only fail there.

**Honest limits.** The token travels through Expo's push service (and Google's), so you are
trusting them with a single-use, 5-minute, single-purpose secret. Anyone who can read your
phone's notifications can approve. There is a small window between the final check and
`rm` in which a session could swap a directory for a symlink; `--one-file-system` and the
re-check narrow it, and the request is still limited to an app's own folder.

Fallback on the host (not reachable over the SSH key): `sudo homelab-gateway --admin approve <id>`.

## Creating GitHub repos

Sessions only hold a fine-grained GitHub token (no repo creation: GitHub doesn't let those create
personal repos). `homelab create-repo <name>` fills that gap safely: the gateway checks the name and
that the repo doesn't exist, asks on the phone ("Create a private GitHub repo Zawaer/<name>"), and
only then runs one fixed `gh repo create`. It uses a separate GitHub login kept in
`/var/lib/homelab-gateway/gh` on the host, which the container can't see and sessions can't read.
Set it up once as the homelab user, after the installer: `GH_CONFIG_DIR=/var/lib/homelab-gateway/gh
gh auth login --hostname github.com --git-protocol https --web --scopes repo`. That login has the broad
`repo` scope, so it is the one credential to keep on the host only; revoking GitHub's "GitHub CLI"
authorization (Settings, Applications) kills it along with every other `gh` login. A repo it creates
is covered at once by the sessions' "All repositories" token.

## Per-project access

`RENKI_HOMELAB_REPOS` (daemon environment, e.g. `renki,talkoot,pihi`) lists the repos
whose sessions may use `homelab`. Unset = every session may; set but empty = none; `@plain`
covers repo-less sessions. For any other session the daemon registers a `PreToolUse` hook
(`apps/daemon/src/claude/homelabGuard.ts`) that refuses Bash commands that run `homelab` or
name the gateway's key/address, and tells Claude to stop and ask you. A hook is used instead of
`canUseTool` because hooks run in every permission mode, including Auto.

**This is a guardrail, not a wall.** Sessions share one container and one user, so a session
set on getting around it can (it can read the key file, or write the ssh command in a way the
matcher doesn't recognise). It stops accidents and the lazy kind of prompt injection. What
actually limits the damage is the rest of this document: the verb allowlist, the protected
paths, and phone approval. The setting lives in the daemon's own environment (`~/renki/.env`
on the host), which sessions cannot edit; changing it needs a daemon restart.

## What this does not cover

- Money and external services: handled by scoping credentials per project, not here.
- Data loss from an app's own bug: Backrest snapshots (see `docs` / Backrest plans).
- A compromised homelab host: the gateway is a guardrail for sessions, not a sandbox
  against root.
