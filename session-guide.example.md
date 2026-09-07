# Session guide (template)

Copy this into the `.claude` directory you mount into the daemon, as
`CLAUDE.md`, and edit the bracketed bits. Every Claude session running inside
CRC then reads it automatically, so sessions know the things about *your* setup
they cannot work out from inside a container.

```bash
cp session-guide.example.md ~/.claude/CLAUDE.md   # then edit it
```

Why bother: a session can see its own worktree and nothing else. Left to guess,
it will offer you `npm run dev` and a localhost link that doesn't work, hang
forever on an interactive prompt, or try to push to a branch that has no
upstream. None of that is the model being careless — it simply has no way to
know. Keep this file dense: it is prepended to every session's context.

Everything below is worded for the session to read, not for you.

---

## Where you are

You are a **Claude Remote Control session**: a `claude` process on a homelab,
driven remotely over HTTP/WebSocket. The user is not at a terminal watching
scrollback — they are reading your transcript in a web app, a phone app, or a
VS Code panel, possibly hours later, possibly while several other sessions run
alongside you.

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

## How the user sees you

- **They may be on a phone.** Favour short, scannable answers over wide tables
  and long code dumps. Say what changed and what it means.
- **Approvals are remote and time out.** When you call a gated tool, a prompt
  goes to whichever device holds control and is **auto-denied after
  [5 minutes]** if nobody answers. So: don't fire off a dozen approvals in a
  row, and write a genuine one-line `description` for every Bash call — that
  sentence is what they see and judge, often on a small screen.
- **They can interrupt you mid-task.** A message sent while you are working
  arrives at your next tool-call boundary, inside the same turn. Treat it as a
  correction or addition to the current work, not a new conversation.
- **Long commands background themselves.** A Bash call that runs past its
  timeout (~2 minutes) keeps going in the background and notifies you when it
  finishes. Prefer that to splitting a build into pieces.

## No terminal, so nothing interactive

There is no TTY. Anything that waits for keyboard input hangs until it is
killed, wasting the turn. Avoid `git rebase -i`, `git add -p`, `vim`/`nano`,
`npm init`, `gh auth login`, `sudo` password prompts, and REPLs.

Use the non-interactive form instead: `git rebase --onto`, `git apply`, writing
the file directly, `npm init -y`, `--yes`/`--no-input`/`--batch` flags, or a
heredoc piped into the program.

## Git, branches and merging

Your worktree is on its own branch (`crc/<id>` unless the user named one), cut
from a base branch. That branch has **no upstream**, which is deliberate.

- Commit freely in your worktree — that is the point of it.
- **Don't push to `main`** or force-push anything. The user merges a session's
  work back with `crc merge` (which auto-merges when clean and spawns a
  conflict-resolution session when not).
- If they explicitly ask you to push, push the session branch and say what you
  pushed.

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

## Working in parallel

Background agents outlive the turn that spawned them: their tool approvals
still reach the user and their results arrive whenever they finish. If the user
gives you a second, independent task while you are mid-way through something,
spawning a background agent for it is usually better than making them wait.

## [Anything else specific to this host]

Add what a session cannot discover for itself, for example:

- services already running and the ports they occupy
- whether `git push` works here (does `gh auth status` succeed?)
- databases or fixtures available for local testing
- house style or review rules you want every session to follow
