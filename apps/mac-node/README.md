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

## Build jobs (`mac_build`)

Sessions can run build jobs on the Mac, such as a fast Android build with warm Gradle caches, and get the APK
and log back on the homelab, or have the APK installed straight onto the phone.

**Jobs are defined only on the Mac**, in `mac-node.json`:

```json
"jobs": {
  "matka": {
    "android-debug": {
      "description": "Debug build of the Expo app",
      "cwd": "mobile",
      "command": "npm install && npx expo prebuild -p android --no-install && cd android && ./gradlew assembleDebug",
      "timeoutMinutes": 30,
      "artifacts": ["mobile/android/app/build/outputs/apk/debug/app-debug.apk"],
      "installApk": "mobile/android/app/build/outputs/apk/debug/app-debug.apk"
    }
  }
}
```

A session can only name a job. The protocol has no command field, so even a compromised homelab can't choose
what runs. Before each job, the session's working tree (git-tracked and new files) is mirrored into
`~renki-runner/work/<project>`. Only changed files are sent, and each one is checked against its sha1.

A build still runs the repo's own build scripts, and a session can edit those. So builds run in a
**separate Linux VM**: a Colima profile, `renki-runner`, used for nothing else (`src/vm.ts`).

- **A separate kernel.** Your Mac's files, keychain, SSH keys, this agent's Renki token and its
  localhost services (Screenpipe, the adb server, Ollama, Bitwarden, SSH tunnels, dev servers) aren't
  in the VM at all. No folders are shared into it (`--mount none`), and the agent checks that before
  using it.
- **A firewall inside the VM.** It rejects everything from the build network to the Mac (the
  `192.168.5.2` gateway, which would otherwise forward to the Mac's localhost), the LAN, the tailnet
  (so not the homelab) and the VM itself. Builds keep the internet, for Maven and npm.
- **An unprivileged container.** Builds run as uid 1000 with no capabilities and `no-new-privileges`,
  in one long-lived container, so Gradle's daemons stay warm between jobs.
- **Fail closed.** Before every job, the agent probes from inside the container. It must be refused by
  a listener on the Mac's localhost and by the homelab, and must reach its own loopback and the
  internet. Otherwise nothing runs.
- **Nothing comes back through shared files.** Results only come back over stdout, so a build can't
  plant a symlink that makes the agent, which runs as you, read or upload your files.
- **Only uses memory while needed.** The VM starts on the first job and stops after 30 idle minutes, or
  as soon as you switch lending off. The SDK, caches and project mirrors stay in a Docker volume.
- **Installs ask.** `install: true` asks whoever holds control, like `phone_install_apk`.

Android's Linux host tools (aapt2, NDK, CMake) are x86_64 only. They run under Rosetta, which needs
`sudo softwareupdate --install-rosetta --agree-to-license` once; without it they fall back to much
slower QEMU emulation.

What remains: a build can use the internet, for example to send the project's source somewhere. The
homelab and GitHub already hold that source.

## What a session can and can't do

- It can look at the phone (devices, screenshots, logcat) and tap or type on it without asking.
- `phone_shell` (the phone's shell, never the Mac's) and `phone_install_apk` ask whoever holds control, in every permission mode.
- It can't do anything else on the Mac. Every call is checked again on the Mac against the shared schemas
  (`packages/protocol/src/mac.ts`). `adb` runs from an argv array, not through a shell, and only the
  `devices`, `exec-out screencap`, `logcat`, `shell` and `install` subcommands are used, so no call can
  become `adb pull` or `push`.
- On the daemon, `RENKI_MAC_REPOS` (same format as `RENKI_HOMELAB_REPOS`) limits which projects get the tools. Unset means all projects.
