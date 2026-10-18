# Renki Mac

Lends your Mac's `adb`, and the Android phone plugged into it, to Renki
sessions running on another host. Sessions on the homelab get `mac` tools
(`phone_devices`, `phone_screenshot`, `phone_logcat`, `phone_input`,
`phone_shell`, `phone_install_apk`) and keep working where they are.

```
session (homelab) --mcp--> daemon --/mac/ws--> Renki Mac (this) --adb--> phone
```

The Mac dials out to the daemon, so it opens no ports. A menu bar switch,
**Lend this Mac to Renki**, starts and stops the agent: when it's off, Renki
can't reach the Mac at all.

## Setup

```sh
bash apps/mac-node/macos/setup.sh                 # daemon URL (default https://renki.internal/api) + token
bash apps/mac-node/macos/build-app.sh             # builds ~/Applications/Renki Mac.app
open ~/Applications/"Renki Mac.app"               # then: menu bar > Lend this Mac to Renki
```

Settings live in `~/Library/Application Support/Renki/mac-node.json`.
`"verbs": { "shell": false }` switches a verb off on this Mac, whatever the
daemon asks for. Logs are in `~/Library/Logs/Renki/mac-node.log`.

## What a session can and can't do

- It can look at the phone (devices, screenshots, logcat) and tap or type on it without asking.
- `phone_shell` (the phone's shell, never the Mac's) and `phone_install_apk` ask whoever holds control, in every permission mode.
- It can't do anything else on the Mac. Every call is checked again on the Mac against the shared schemas
  (`packages/protocol/src/mac.ts`). `adb` runs from an argv array, not through a shell, and only the
  `devices`, `exec-out screencap`, `logcat`, `shell` and `install` subcommands are used, so no call can
  become `adb pull` or `push`.
- On the daemon, `RENKI_MAC_REPOS` (same format as `RENKI_HOMELAB_REPOS`) limits which projects get the tools. Unset means all projects.
