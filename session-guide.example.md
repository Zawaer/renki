# Session guide (template)

Copy this into the `.claude` directory you mount into the daemon, as
`CLAUDE.md`, and edit the bracketed bits. Every Claude session running inside
Renki then reads it automatically, so sessions know the things about *your* setup
they cannot work out from inside a container.

```bash
cp session-guide.example.md ~/.claude/CLAUDE.md   # then edit it
```

Why bother: a session can see its own worktree and nothing else. Left to guess,
it will offer you `npm run dev` and a localhost link that doesn't work, or a
build that takes an hour on this box. None of that is the model being careless —
it simply has no way to know. Keep this file dense: it is prepended to every
session's context.

What holds for every Renki install (the app, phones, approvals, no TTY, the
session branch, `renki merge`) is already in the prompt the daemon adds to
Claude Code's own (`apps/daemon/src/claude/systemPrompt.ts`), so leave it out of
here. This file is for your host: paths, previews, hardware, services.

Everything below is worded for the session to read, not for you.

---

## Where you are

You run as **root inside a Docker container**, which means:

- **`/repos`** — the user's actual repositories, bind-mounted from the host.
  Real files, shared with every other session and with the host. Do not run
  destructive git operations here; work in your own worktree instead.
- **`/data/worktrees/<session-id>`** — your worktree. This is your workspace.
- **Everything else is ephemeral.** Packages you `apt-get install`, files you
  leave in `/tmp` or `/root`, servers you start: all gone when the daemon is
  rebuilt or restarted, which happens on every deploy.
- **No host access.** You cannot see the host filesystem, the Docker socket,
  or other containers. Do not try to restart the daemon — that is the process
  running you.

Outbound internet works. `git` and `python3` are available; other tooling may
not be, and installing it only lasts until the next rebuild.

## Showing the user something in a browser

Any HTTP server you start is reachable from their devices at:

    [https://p<port>.preview.internal]

e.g. a server on port 3000 becomes [https://p3000.preview.internal]. You do not
need to publish ports, build SSH tunnels, or install anything.

- **Bind `0.0.0.0`, not localhost.** Docker networking cannot reach the
  container's own loopback: `next dev -H 0.0.0.0`, `vite --host`,
  `python3 -m http.server --bind 0.0.0.0`.
- **Pick an unlikely port.** Nothing on the host can clash (this maps to the
  container's own ports), but concurrent sessions can clash with each other —
  prefer `3123` over `3000`.
- When you have something worth looking at, **start the server and hand over
  the URL**, rather than instructions for running it themselves.
- A preview dies when the container is replaced. A 502 on a preview URL means
  the route is fine and nothing is listening — start the server again.

## Operating the homelab

You run in a container, but you can operate the host through one command, `homelab`
(a restricted gateway, not a shell). It only does what its policy allows, and every call is logged.

- `homelab status [app]`, `homelab logs <container> [--since 1h] [--lines N]`, `homelab top`,
  `homelab backup-audit`: read-only, always fine. Use `top` first for "why is the CPU high".
- `homelab deploy <app>` (git pull --ff-only, then rebuild), `homelab restart <app>`,
  `homelab builder-prune` (frees Docker build cache only), `homelab caddy-reload`: allowed for
  the apps in the policy. Commit and push your change before you deploy it.
- `homelab deploy renki` runs detached and restarts the daemon, which ends in-flight turns:
  check that no other session is busy first, and read the result later with `homelab job <id>`.
- If a call is refused with "This project doesn't have homelab access", the user has switched
  the command off for this project: stop, say what you wanted and why, and let them decide.
- Photos, location history, notes, backups and anything else on the protected list are out of
  reach on purpose. If a verb answers "refused", don't look for a way around it: tell the user
  what you wanted to do and why, and let them decide.
- `homelab create-repo <name> [--public]` creates an empty GitHub repo (private unless --public) once the
  user approves it on their phone; after that you can clone it and push as usual. You can't create repos any other way.
- Deleting things (`homelab rm-path <absolute path>`, `homelab remove-container <name>`) sends the
  user an approval on their phone and waits up to 5 minutes for it. Say what you are asking
  to delete and why before you run it; if it comes back "denied", don't retry or look for
  another way. Never try to reach the Docker socket or SSH to the host some other way.

## [Anything else specific to this host]

Add what a session cannot discover for itself, for example:

- services already running and the ports they occupy
- whether `git push` works here (does `gh auth status` succeed?)
- databases or fixtures available for local testing
- house style or review rules you want every session to follow
