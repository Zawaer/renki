# Session guide (template)

Copy this into the `.claude` directory you mount into the daemon, as
`CLAUDE.md`, and edit the bracketed bits. Every Claude session running inside
CRC then reads it automatically, so sessions know things about *your* host that
they cannot work out from inside a container.

```bash
cp session-guide.example.md ~/.claude/CLAUDE.md   # then edit it
```

Why bother: a session can see its own worktree and nothing else. It does not
know that a dev server it starts is unreachable, that a preview URL exists, or
which ports are already taken. Left to guess, it will offer you `npm run dev`
and a localhost link that doesn't work, or spend a turn building an SSH tunnel.

Everything below is worded for the session to read, not for you.

---

## This machine

You are running inside the CRC daemon container on a homelab, not on the user's
laptop. Repos live under `/repos` and each session's git worktree under
`/data/worktrees`. Anything outside those paths belongs to the container, not
the host, and disappears when the daemon is rebuilt.

## Showing the user something in a browser

Any HTTP server you start is reachable from their devices at:

    [https://p<port>.preview.internal]

e.g. a server on port 3000 becomes [https://p3000.preview.internal]. You do not
need to publish ports, build SSH tunnels, or install anything.

Two requirements:

- **Bind `0.0.0.0`, not localhost.** Docker networking cannot reach the
  container's own loopback: `next dev -H 0.0.0.0`, `vite --host`,
  `python3 -m http.server --bind 0.0.0.0`.
- **Pick an unlikely port.** Nothing on the host can clash (this maps to the
  container's own port space), but two sessions running at once can clash with
  each other — prefer something specific like `3123` over `3000`.

When you have something worth looking at, start the server and hand over the
preview URL, rather than instructions for running it themselves.

A preview dies when the daemon is rebuilt or restarted, because the container it
runs in is replaced. If the user reports a 502 on a preview URL, the route is
fine and the server simply isn't running any more — start it again.

## Git

Commits work normally. Whether `git push` works depends on whether this host
gave the container a GitHub login (see SETUP.md § Pushing to GitHub); if
`gh auth status` succeeds, pushing and `gh` commands will too. Never invent
credentials or ask the user to paste a token into the chat.

## [Anything else specific to this host]

Add what a session cannot discover for itself, for example:

- services already running and the ports they occupy
- databases or fixtures available for local testing
- house style or review rules you want every session to follow
