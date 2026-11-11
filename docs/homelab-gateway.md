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
| 2 approval | `add-app <name> [--dir d] [--repo r] [--services a,b]` | a new `deploy` app in `~/<dir>` (cloned from `<owner>/<repo>` first with `--repo`). Refused if its compose file does what an app never may (privileged, host network/pid, cap_add, devices, docker.sock, or a bind of a system folder, the whole home, keys, settings or Renki's data). Other folders outside its own are listed in the phone approval (read only or can change files, flagged when on the protected list) and remembered per app; a later deploy that needs a new one, or read-write where read-only was approved, asks the phone again before rebuilding. Stored in `/var/lib/homelab-gateway/added-apps.json`, which only the gateway writes; `policy.json` wins on a name clash |
| 2 approval | `add-route <name>[.internal] <container>:<port>` | appends a `<name>.internal` site to the Caddyfile for a container of a deployable app on `homelab_net`, validates, reloads; puts the file back if it doesn't validate |
| 2 approval | `sh <command>` | runs the command with `bash -lc` as the homelab user, in its home, after the phone shows the exact command and you approve; no approval while a time window is open |
| 2 approval | `sudo <command>` | the same as root: you type your sudo password in the phone's approval, every time (see below) |
| 2 approval | `open-window [minutes]` | after one approval, `sh` runs without asking for that long (default 30, at most 120); `close-window` ends it, `window` shows it |
| never | anything else | any verb not listed; `sh` and `sudo` are the way to do something new, and they always show you the command |

## Policy

The implemented policy is `ops/homelab-gateway/policy.json` (plain JSON, so the gateway needs no
extra Python packages); the YAML below is the readable summary. Tiers 0, 1 and 2 are implemented.

```yaml
# /etc/homelab-gateway/policy.yml
apps:
  deploy:            # tier 1 allowed without asking
    - talkoot
    - puntari
    - scout-tool
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

No tier-2 verb runs on a session's say-so (`sh` inside a time window is the one exception, see below).

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

## Host commands: `sh`, `sudo` and the time window

The fixed verbs cover the everyday jobs. For the rest (renaming an app's folder, moving files,
docker commands, systemd units) a session runs `homelab sh '<command>'`. This is a full shell as the
homelab user, which is in the docker group and so close to root. What limits it is that you read the
exact command on the phone before it runs. Unlike the other approvals, the text you approve here was
written by the session, so read it.

`homelab sudo '<command>'` runs a command as root. The approval asks for your sudo password, and sudo
itself checks it (`sudo -k -S`: never a cached login, none left behind). No sudoers rule is involved.
The password never travels in the clear and never passes the daemon: the push carries a one-time pad
next to the token; the phone XORs the password with it and sends only that to the approval service,
which keeps it for the second until the waiting gateway reads it, deletes it and undoes the XOR with
the pad it kept in memory.

`homelab open-window [minutes]` is for a long job you're watching. After one approval, `sh` runs
without asking until the window closes; every command is still in the audit log. Sessions share one
container and one key, so the gateway can't tell chats apart: a window is open to **every** chat with
homelab access, and the approval says so. Every Renki tab shows a banner while it is open, with
"End now" (`POST /v1/window/close` on the approval service, which needs no token since it only takes
access away). `sudo` asks every time, window or not. A command run in a window runs as the homelab
user, which can write the gateway's state folder, so it could extend the window itself: treat an open
window as trusting the chat with the host for that long.

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

`RENKI_HOMELAB_REPOS` (daemon environment, e.g. `renki,talkoot,puntari`) lists the repos
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
