import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";

/**
 * Optional PreToolUse hook that pipes Bash calls through RTK
 * (https://github.com/rtk-ai/rtk), a local CLI proxy that rewrites commands
 * (e.g. `git status` -> `rtk git status`) to shrink their output before it
 * ever reaches the model. `rtk init -g` normally wires this in via Claude
 * Code's own settings.json hook mechanism, but any hooks a repo's own
 * settings.json defines get stripped before every turn (see
 * settingsHygiene.ts) — so we call RTK's own hook binary directly as an
 * in-code hook instead, passed through the SDK's `hooks` option rather than
 * a repo file. Requires `rtk` to be installed and on PATH on the machine
 * running the daemon (not the connecting client).
 *
 * Fails open on any problem — not found, crash, malformed output — so a
 * broken or missing rtk install never blocks a real command from running.
 */
const PASSTHROUGH: HookJSONOutput = { continue: true };

async function runRtkHook(bin: string, input: HookInput, signal: AbortSignal): Promise<HookJSONOutput> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ["hook", "claude"], { stdio: "pipe" });
  } catch {
    return PASSTHROUGH;
  }

  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", () => {}); // discarded — failures fail open, see above

  const onAbort = () => child.kill();
  signal.addEventListener("abort", onAbort);

  try {
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(-1));
      child.stdin.write(JSON.stringify(input), (err) => {
        if (err) resolve(-1);
        else child.stdin.end();
      });
    });

    if (exitCode !== 0) return PASSTHROUGH;

    const raw = Buffer.concat(stdout).toString("utf8").trim();
    if (!raw) return PASSTHROUGH;

    return JSON.parse(raw) as HookJSONOutput;
  } catch (err) {
    logger.debug("rtk hook failed, passing command through unchanged", { err: String(err) });
    return PASSTHROUGH;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** `bin` is the `rtk` executable to invoke — name on PATH or absolute path (RENKI_RTK_BIN). */
export function createRtkPreToolUseHook(bin: string): HookCallbackMatcher {
  return {
    matcher: "Bash",
    hooks: [
      async (input, _toolUseID, { signal }) => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return PASSTHROUGH;
        return runRtkHook(bin, input, signal);
      },
    ],
  };
}
