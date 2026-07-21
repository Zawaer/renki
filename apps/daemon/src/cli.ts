import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { encodePairing } from "@crc/client-core";
import type { SessionEvent } from "@crc/protocol";
import QRCode from "qrcode";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { logger } from "./logger.js";
import { scanRepos } from "./repos.js";
import { checkTailscaleServeConflict, getTailscaleStatus } from "./tailscale.js";
import type { PermissionResolver } from "./claude/runner.js";
import { SessionError } from "./sessions/errors.js";
import { SessionManager } from "./sessions/manager.js";

const execFileAsync = promisify(execFile);

/**
 * Step-1 harness. NO networking — this drives the SessionManager directly so we
 * can prove sessions run isolated in worktrees, stream events, and survive a
 * daemon restart (state lives in SQLite, not memory). Step 2 replaces this
 * entry point's role with a WebSocket/REST server calling the same manager.
 *
 * Usage:
 *   crc init
 *   crc repos
 *   crc new <repoId> [--base <branch>] [--branch <name>] [--title <t>]
 *   crc sessions
 *   crc prompt <sessionId> <text...> [--model <m>]
 *   crc transcript <sessionId>
 *   crc archive <sessionId>
 */

const DEVICE_ID = "cli";
const DEVICE_NAME = "CLI";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      model: { type: "string" },
    },
  });

  const [command, ...rest] = positionals;

  const config = loadConfig();

  if (command === "token") {
    // Resolved the same way the running daemon resolves it: CRC_AUTH_TOKEN if
    // set, else the persisted (or just-minted) <dataDir>/auth-token.
    process.stdout.write(`${config.authToken}\n`);
    return;
  }

  if (command === "init") {
    await runInit(config);
    return;
  }

  if (command === "repos") {
    const repos = await scanRepos(config);
    if (repos.length === 0) {
      console.log(`No git repos found under ${config.reposRoot} (set CRC_REPOS_ROOT).`);
      return;
    }
    for (const r of repos) console.log(`${r.id}\t(${r.defaultBranch})\t${r.path}`);
    return;
  }

  // Connect a claude.ai usage session key without a running daemon. Two-step so
  // YOU pick the org (an account often has an empty personal org + the real one):
  //   crc usage login                    open a browser, sign in; prints key + orgs
  //   crc usage orgs <key>               list the orgs a key can see (pick one)
  //   crc usage connect <key> <orgId>    track that org's usage
  if (command === "usage") {
    const { UsageReader } = await import("./accounts/usage.js");
    const reader = new UsageReader(config.usageConfigPath, config.usageBaseUrl);
    const printOrgs = (
      orgs: { orgId: string; name: string; usage: { fiveHour: { pct: number }; sevenDay: { pct: number } } | null }[],
    ) => {
      for (const o of orgs) {
        const u = o.usage ? `5h ${o.usage.fiveHour.pct}% · 7d ${o.usage.sevenDay.pct}%` : "no usage data";
        console.log(`${o.orgId}\t${u}\t${o.name}`);
      }
      console.log("\nConnect one with: crc usage connect <key> <orgId>");
    };

    if (rest[0] === "login") {
      const { loginAndExtractSessionKey, PlaywrightUnavailableError } = await import("./accounts/login.js");
      try {
        console.log("Opening a browser — sign in to claude.ai in the window that appears…");
        const key = await loginAndExtractSessionKey({
          baseUrl: config.usageBaseUrl,
          channel: config.usageLoginChannel || undefined,
          timeoutMs: config.usageLoginTimeoutMs,
        });
        const { orgs } = await reader.listOrgs(key);
        console.log(`\nsession key: ${key}\n`);
        printOrgs(orgs);
      } catch (err) {
        return fail(err instanceof PlaywrightUnavailableError ? err.message : err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (rest[0] === "orgs") {
      const key = rest[1];
      if (!key) return fail("usage: crc usage orgs <sessionKey>");
      printOrgs((await reader.listOrgs(key)).orgs);
      return;
    }
    if (rest[0] === "connect") {
      const key = rest[1];
      const orgId = rest[2];
      if (!key || !orgId) return fail("usage: crc usage connect <sessionKey> <orgId>  (list orgs: crc usage orgs <key>)");
      const id = await reader.addKey(key, orgId);
      console.log(`connected ${id.email ?? "(email unknown)"} — 5h ${id.usage.fiveHour.pct}% · 7d ${id.usage.sevenDay.pct}%`);
      return;
    }
    return fail("usage: crc usage login | crc usage orgs <key> | crc usage connect <key> <orgId>");
  }

  const db = openDb(config);
  const manager = new SessionManager(config, db);

  switch (command) {
    case "new": {
      const repoId = rest[0];
      if (!repoId) return fail("usage: crc new <repoId> [--base <branch>]");
      const base = values.base ?? (await defaultBranchFor(config, repoId));
      const session = await manager.createSession({
        repoId,
        baseBranch: base,
        newBranch: values.branch,
        title: values.title,
      });
      console.log(`created ${session.id}`);
      console.log(`  repo=${session.repoName} branch=${session.branch} base=${session.baseBranch}`);
      console.log(`  worktree=${session.worktreePath}`);
      break;
    }

    case "sessions": {
      const list = manager.listSessions();
      if (list.length === 0) console.log("no sessions");
      for (const s of list) {
        const ctrl = s.controller ? `controller=${s.controller}` : "unlocked";
        console.log(`${s.id}\t${s.status}\t${s.repoName}:${s.branch}\t${ctrl}\t${s.title ?? ""}`);
      }
      break;
    }

    case "transcript": {
      const id = rest[0];
      if (!id) return fail("usage: crc transcript <sessionId>");
      for (const e of manager.events.read(id)) console.log(`#${e.seq}\t${e.kind}\t${compact(e)}`);
      break;
    }

    case "prompt": {
      const id = rest[0];
      const text = rest.slice(1).join(" ");
      if (!id || !text) return fail('usage: crc prompt <sessionId> "your prompt"');

      // Single-device CLI: acquire the lock, then send. Exercises the real
      // control path (submitPrompt refuses if we're not the controller).
      manager.takeControl(id, DEVICE_ID, DEVICE_NAME);

      const unsubscribe = manager.events.subscribe(id, render);
      try {
        await manager.submitPrompt({
          sessionId: id,
          deviceId: DEVICE_ID,
          promptId: `p_${Date.now()}`,
          text,
          model: values.model,
          resolvePermission: cliPermissionResolver,
        });
      } finally {
        unsubscribe();
      }
      process.stdout.write("\n");
      break;
    }

    case "archive": {
      const id = rest[0];
      if (!id) return fail("usage: crc archive <sessionId>");
      await manager.archiveSession(id);
      console.log(`archived ${id}`);
      break;
    }

    default:
      return fail(
        "commands: token | repos | usage login|connect | new <repoId> | sessions | prompt <sessionId> <text> | transcript <sessionId> | archive <sessionId>",
      );
  }
}

/**
 * CLI permission policy. Default AUTO-ALLOW so the harness runs unattended, but
 * every request is printed so we can see the permission events flowing through
 * the log. Override with CRC_CLI_PERMISSION=deny to watch denials instead.
 */
const cliPermissionResolver: PermissionResolver = async (req) => {
  const decision = process.env.CRC_CLI_PERMISSION === "deny" ? "deny" : "allow";
  process.stdout.write(`\n  ⟶ [permission] ${req.toolName} → ${decision}\n`);
  return { decision, byDeviceId: DEVICE_ID };
};

/** Pretty-print live events to stdout, giving the token-streaming effect. */
function render(e: SessionEvent): void {
  switch (e.kind) {
    case "assistant_delta":
      // Only stream text/thinking deltas; tool_use is shown via assistant_block.
      if (e.blockKind === "text") process.stdout.write(e.text);
      else if (e.blockKind === "thinking") process.stdout.write(dim(e.text));
      break;
    case "assistant_block":
      if (e.blockKind === "tool_use") process.stdout.write(`\n  ⚙ ${e.toolName}(${compactJson(e.toolInput)})\n`);
      break;
    case "tool_result":
      process.stdout.write(`  ↳ ${e.ok ? "ok" : "ERR"}: ${oneLine(e.summary)}\n`);
      break;
    case "turn_result":
      process.stdout.write(
        `\n  ✓ turn ${e.ok ? "ok" : `error: ${e.errorMessage}`}` +
          (e.costUsd != null ? ` ($${e.costUsd.toFixed(4)}, ${e.durationMs}ms)` : "") +
          "\n",
      );
      break;
    default:
      break;
  }
}

async function defaultBranchFor(config: ReturnType<typeof loadConfig>, repoId: string): Promise<string> {
  const repos = await scanRepos(config);
  const repo = repos.find((r) => r.id === repoId);
  return repo?.defaultBranch ?? "main";
}

/**
 * One-shot bootstrap wizard: confirms repos are found, offers to run
 * `tailscale serve` if Tailscale is detected, then prints the first pairing
 * QR straight to the terminal. Closes the gap where today's QR pairing needs
 * one client already configured by hand before it can onboard the rest.
 * Never hard-fails — worst case it still prints a loopback QR + the manual
 * values, same as a client with no Tailscale would show.
 */
async function runInit(config: ReturnType<typeof loadConfig>): Promise<void> {
  console.log(`Auth token: ${config.authToken}\n`);

  const repos = await scanRepos(config);
  if (repos.length === 0) {
    console.log(`No git repos found under ${config.reposRoot} (set CRC_REPOS_ROOT in .env if yours live elsewhere).\n`);
  } else {
    console.log(`Found ${repos.length} repo(s) under ${config.reposRoot}: ${repos.map((r) => r.id).join(", ")}\n`);
  }

  console.log("Checking Tailscale…");
  const status = await getTailscaleStatus();

  let baseUrl = `http://127.0.0.1:${config.port}`;
  let loopback = true;

  if (status.available && status.hostname) {
    console.log(`Detected: ${status.hostname}`);

    const conflict = await checkTailscaleServeConflict(config.port);
    if (conflict.conflicting) {
      console.log(
        `\nWarning: "tailscale serve" already points this tailnet's HTTPS at\n` +
          `${conflict.existingProxyTarget} — continuing will overwrite that.\n`,
      );
    } else {
      console.log(
        "\nNote: this claims <tailnet-ip>:443 directly. If another reverse proxy\n" +
          "(Caddy, Traefik, nginx…) is already bound to that same address for other\n" +
          "sites, it can silently lose the port — see SETUP.md step 4 if you're unsure.\n",
      );
    }

    const proceed = await confirm(`Run "tailscale serve --bg ${config.port}" now?`, {
      defaultYes: !conflict.conflicting,
    });
    if (proceed) {
      const ok = await tryTailscaleServe(config.port);
      if (ok) {
        baseUrl = `https://${status.hostname}`;
        loopback = false;
        console.log(`"tailscale serve" running — ${baseUrl} now proxies to this daemon.\n`);
      } else {
        console.log(
          `\nCouldn't run it automatically — this usually means the tailnet operator isn't set to your\n` +
            `user yet. Run this once, then "crc init" again to pick up the real address:\n` +
            `  sudo tailscale set --operator=$USER\n` +
            `  tailscale serve --bg ${config.port}\n`,
        );
      }
    } else {
      console.log('Skipped. Run it yourself later, then "crc init" again to pick up the real address.\n');
    }
  } else {
    console.log(
      "Not detected (tailscale not installed, or not logged into a tailnet). Install it and run\n" +
        '"tailscale up", then "crc init" again — see SETUP.md for other ways to reach the daemon.\n',
    );
  }

  if (loopback) {
    console.log(
      `Showing a LOOPBACK-only QR (${baseUrl}) — it only works from this machine.\n` +
        "Scan it now only if you're pairing a client on this same host; otherwise fix Tailscale above first.\n",
    );
  }

  const payload = encodePairing({ baseUrl, token: config.authToken });
  console.log(`Scan with the CRC app's "Scan QR code" (Setup screen) to connect:\n`);
  console.log(await QRCode.toString(payload, { type: "terminal", small: true }));
  console.log(`Or enter manually — Daemon URL: ${baseUrl}   Token: ${config.authToken}`);
}

async function confirm(question: string, { defaultYes = true }: { defaultYes?: boolean } = {}): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
    const trimmed = answer.trim();
    if (trimmed === "") return defaultYes;
    return /^y(es)?$/i.test(trimmed);
  } finally {
    rl.close();
  }
}

async function tryTailscaleServe(port: number): Promise<boolean> {
  try {
    await execFileAsync("tailscale", ["serve", "--bg", String(port)], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

// ── tiny formatting helpers ────────────────────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 200);
const compactJson = (v: unknown) => oneLine(JSON.stringify(v ?? {}));
const compact = (e: SessionEvent) => {
  const { seq, sessionId, ts, kind, ...rest } = e as Record<string, unknown>;
  return compactJson(rest);
};

main()
  .catch((err) => {
    if (err instanceof SessionError) fail(`${err.code}: ${err.message}`);
    else {
      logger.error("cli failed", { err: err instanceof Error ? err.stack : String(err) });
      process.exitCode = 1;
    }
  })
  .finally(() => {
    // The SDK spawns a child process; ensure we don't linger once work is done.
    process.exit(process.exitCode ?? 0);
  });
