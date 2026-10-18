import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createSdkMcpServer, tool, type HookCallbackMatcher, type HookJSONOutput, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { AdbSerial, MacName, MacVerbArgs, type MacVerb } from "@renki/protocol";
import { z } from "zod";
import { MAC_OFFLINE, type MacBridge, type MacResult } from "./bridge.js";
import { ManifestError, buildManifest, type MacJobs } from "./jobs.js";

/**
 * The `mac` MCP server every allowed session gets: the phone plugged into the
 * user's Mac, reached through the Mac bridge (./bridge.ts). Registered whether
 * or not a Mac is attached right now, since a live session outlives many
 * connects and disconnects; an offline Mac answers each call with how to fix it.
 *
 * Reading the phone (devices, screenshot, logcat) and tapping/typing on it run
 * without asking. A free phone shell and installing an APK ask the controller
 * first, in every permission mode (see createMacApprovalHook).
 *
 * `mac_build` runs one of the build jobs the user defined on the Mac, by name.
 * Sessions can't send a command: the Mac's config is the only place one is
 * written. The job runs as a sandboxed user on the Mac (apps/mac-node/README.md).
 */

export const MAC_SERVER = "mac";
const tid = (name: string) => `mcp__${MAC_SERVER}__${name}`;

/** Tools that change what is on the phone; these always ask. */
export const MAC_ASK_TOOLS = [tid("phone_shell"), tid("phone_install_apk")];
/** Builds the user defined on the Mac; ask only when the build is to be installed on the phone. */
export const MAC_BUILD_TOOL = tid("mac_build");
/** Tools that only look or tap, and builds without install; allowed without asking. */
export const MAC_FREE_TOOLS = [tid("phone_devices"), tid("phone_screenshot"), tid("phone_logcat"), tid("phone_input"), MAC_BUILD_TOOL];

const MAX_APK_BYTES = 500 * 1024 * 1024;

function asToolResult(r: MacResult) {
  return {
    content: [
      { type: "text" as const, text: r.text || (r.ok ? "Done." : "Failed.") },
      ...(r.image ? [{ type: "image" as const, data: r.image.data, mimeType: r.image.mediaType }] : []),
    ],
    ...(r.ok ? {} : { isError: true }),
  };
}

export type MacSessionContext = { cwd: string; sessionId: string; /** The session's repo name: the project's name on the Mac. Null for repo-less chats. */ project: string | null };

export function createMacMcpServer(bridge: MacBridge, jobs: MacJobs, ctx: MacSessionContext): McpSdkServerConfigWithInstance {
  const { cwd } = ctx;
  const run = async (verb: MacVerb, args: Record<string, unknown>, timeoutMs: number) =>
    asToolResult(await bridge.call(verb, args, timeoutMs));

  return createSdkMcpServer({
    name: MAC_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "phone_devices",
        "List the Android devices adb sees on the user's Mac (USB, or wireless debugging). Start here; pass a device's serial to the other phone_* tools when more than one is listed.",
        MacVerbArgs.devices.shape,
        async () => run("devices", {}, 20_000),
      ),
      tool(
        "phone_screenshot",
        "Take a screenshot of the phone's screen (via the user's Mac). Returns the image, scaled down; coordinates for phone_input are in the phone's real pixels, which the text reports.",
        MacVerbArgs.screenshot.shape,
        async (args) => run("screenshot", args, 30_000),
      ),
      tool(
        "phone_logcat",
        "Read recent Android log lines from the phone (logcat -d). `tags` like [\"ReactNativeJS:V\"] keep only those tags; `grep` filters by substring; `clear` empties the buffer afterwards so the next read shows only new lines.",
        MacVerbArgs.logcat.shape,
        async (args) => run("logcat", args, 30_000),
      ),
      tool(
        "phone_input",
        "Tap, swipe, type text or press a key (BACK, HOME, ENTER…) on the phone. Coordinates are in the phone's real screen pixels.",
        MacVerbArgs.input.shape,
        async (args) => run("input", args, 20_000),
      ),
      tool(
        "phone_shell",
        "Run a command in the PHONE's shell (adb shell), e.g. `am start -n pkg/.MainActivity`, `pm clear pkg`, `dumpsys battery`. Not the Mac's shell. The user approves each call.",
        MacVerbArgs.shell.shape,
        async (args) => run("shell", args, 60_000),
      ),
      tool(
        "phone_install_apk",
        "Install an APK built here onto the phone (adb install -r). `path` is the .apk on this machine, relative to the working directory or absolute. The user approves each install.",
        { path: z.string().min(1), serial: AdbSerial.optional(), downgrade: z.boolean().optional() },
        async ({ path, serial, downgrade }) => {
          const full = resolve(cwd, path);
          let size: number;
          try {
            const st = statSync(full);
            if (!st.isFile()) return asToolResult({ ok: false, text: `${full} is not a file.` });
            size = st.size;
          } catch {
            return asToolResult({ ok: false, text: `${full} doesn't exist.` });
          }
          if (!full.endsWith(".apk")) return asToolResult({ ok: false, text: "Only .apk files can be installed." });
          if (size > MAX_APK_BYTES) return asToolResult({ ok: false, text: `${basename(full)} is over 500 MB.` });
          const fileId = bridge.offerFile(full);
          return run("install", { fileId, name: basename(full), ...(serial ? { serial } : {}), ...(downgrade ? { downgrade } : {}) }, 6 * 60_000);
        },
      ),
      tool(
        "mac_build",
        "Run one of the build jobs the user defined on their Mac for this project (e.g. a fast Android build), on the Mac's faster CPU with warm caches. " +
          "This session's working tree (git-tracked and new files) is mirrored to the Mac first, so build what you have here; you can't pass a command. " +
          "Returns the exit code, the end of the log, and where the job's artifacts (APK, full log) were saved on this machine. " +
          "`install: true` also installs the job's APK on the phone (the user approves that). Call with job \"list\" to see the jobs.",
        { job: z.union([MacName, z.literal("list")]), install: z.boolean().optional(), serial: AdbSerial.optional() },
        async ({ job, install, serial }) => {
          const st = bridge.status();
          if (!st.connected) return asToolResult({ ok: false, text: MAC_OFFLINE });
          if (!ctx.project) return asToolResult({ ok: false, text: "Build jobs need a project (a repo); this chat has none." });
          const defined = st.jobs[ctx.project] ?? [];
          const listing = defined.length
            ? defined.map((j) => `- ${j.name}${j.installs ? " (can install)" : ""}: ${j.description}`).join("\n")
            : `No jobs are defined for "${ctx.project}" on the Mac. The user adds them in the Mac's mac-node.json (jobs > ${ctx.project}); don't look for another way to run commands there.`;
          if (job === "list" || !defined.some((j) => j.name === job)) {
            return asToolResult({ ok: job === "list", text: `${job === "list" ? "" : `There is no job "${job}". `}Jobs for ${ctx.project} on ${st.name}:\n${listing}` });
          }
          let manifest;
          try {
            manifest = await buildManifest(cwd);
          } catch (err) {
            return asToolResult({ ok: false, text: err instanceof ManifestError ? err.message : `Couldn't list the working tree: ${String(err)}` });
          }
          const { id } = jobs.open(cwd, ctx.sessionId, manifest);
          try {
            return await run(
              "run",
              { jobId: id, project: ctx.project, job, manifest, ...(install ? { install } : {}), ...(serial ? { serial } : {}) },
              // The Mac enforces the job's own timeout (60 min at most); this only covers a Mac that vanished.
              70 * 60_000,
            );
          } finally {
            jobs.close(id);
          }
        },
      ),
    ],
  });
}

/**
 * Make the phone tools that change things ask the controller, even in Auto or
 * when settings would allow them. A hook, not canUseTool, because hooks run in
 * every permission mode (same reasoning as homelabGuard.ts).
 */
export function createMacApprovalHook(): HookCallbackMatcher {
  return {
    matcher: [...MAC_ASK_TOOLS, MAC_BUILD_TOOL].join("|"),
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse") return { continue: true };
        const installsBuild = input.tool_name === MAC_BUILD_TOOL && (input.tool_input as { install?: unknown } | null)?.install === true;
        if (!MAC_ASK_TOOLS.includes(input.tool_name) && !installsBuild) return { continue: true };
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "This changes something on the user's phone.",
          },
        };
      },
    ],
  };
}
