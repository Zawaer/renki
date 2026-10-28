import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createSdkMcpServer, tool, type HookCallbackMatcher, type HookJSONOutput, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { AdbSerial, FlashOffset, MacName, MacVerbArgs, SerialPort, type MacVerb } from "@renki/protocol";
import { z } from "zod";
import { MAC_OFFLINE, type MacBridge, type MacResult } from "./bridge.js";
import { describeBuild, type MacBuilds } from "./builds.js";
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
 * written. The job runs in the Mac's build VM (apps/mac-node/README.md). It
 * runs in the background (./builds.ts): the call returns once the job starts,
 * and the result comes back to Claude as a message when it ends.
 */

export const MAC_SERVER = "mac";
const tid = (name: string) => `mcp__${MAC_SERVER}__${name}`;

/** Tools that change what is on the phone or a board; these always ask. */
export const MAC_ASK_TOOLS = [tid("phone_shell"), tid("phone_install_apk"), tid("esp_flash")];
/** Builds the user defined on the Mac; ask only when the build is to be installed on the phone. */
export const MAC_BUILD_TOOL = tid("mac_build");
/** Tools that only look or tap, and builds without install; allowed without asking. */
export const MAC_FREE_TOOLS = [
  tid("phone_devices"),
  tid("phone_screenshot"),
  tid("phone_logcat"),
  tid("phone_input"),
  MAC_BUILD_TOOL,
  tid("mac_build_status"),
  tid("esp_ports"),
  tid("esp_serial"),
  tid("esp_reset"),
];

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

/**
 * Which tool call a mac_build handler is serving. The SDK doesn't tell an MCP
 * handler, but the PreToolUse hook (createMacApprovalHook) sees the id, so it
 * notes it here and the handler takes the latest one for its job. One per
 * `claude` process, shared by its hook and its server.
 */
export class MacCallIds {
  private seen: Array<{ id: string; job: unknown }> = [];

  note(id: string, input: unknown): void {
    this.seen.push({ id, job: (input as { job?: unknown } | null)?.job });
    if (this.seen.length > 20) this.seen.shift();
  }

  /** The newest noted call for this job, forgetting it and anything older (calls that were denied never reach a handler). */
  take(job: string): string | null {
    for (let i = this.seen.length - 1; i >= 0; i--) {
      if (this.seen[i]!.job !== job) continue;
      const { id } = this.seen[i]!;
      this.seen = this.seen.slice(i + 1);
      return id;
    }
    return null;
  }
}

export function createMacMcpServer(
  bridge: MacBridge,
  jobs: MacJobs,
  builds: MacBuilds,
  ctx: MacSessionContext,
  callIds: MacCallIds,
): McpSdkServerConfigWithInstance {
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
        "esp_ports",
        "List the USB serial devices (dev boards such as an ESP32) plugged into the user's Mac. Pass one as `port` to the other esp_* tools when more than one is listed.",
        MacVerbArgs.serial_ports.shape,
        async () => run("serial_ports", {}, 20_000),
      ),
      tool(
        "esp_serial",
        "Read what a board printed on its serial port (115200 baud), on the user's Mac. The first call starts a monitor that keeps collecting in the background, " +
          "so nothing printed between reads is lost, across resets and reflashes too. Each reply ends with `next: N`: pass it as `since` to get only what is new. " +
          "`grep` keeps matching lines. To wait for something the board prints minutes later, end your turn or do other work and read again; don't sleep in a loop.",
        MacVerbArgs.serial_read.shape,
        async (args) => run("serial_read", args, 30_000),
      ),
      tool(
        "esp_reset",
        "Reset an ESP32 on the user's Mac (what pressing its RST button does), with esptool. The serial monitor keeps reading across it, so read its boot with esp_serial.",
        MacVerbArgs.esp_reset.shape,
        async (args) => run("esp_reset", args, 90_000),
      ),
      tool(
        "esp_flash",
        "Flash images built here (e.g. a mac_build job's artifacts) onto an ESP32 on the user's Mac with esptool write_flash, then reset it. " +
          "`images` are .bin files on this machine (relative to the working directory, or absolute) with their flash offsets, like 0x0 for the bootloader, " +
          "0x8000 for the partition table or the app partition's offset. `erase: true` erases the whole chip first. The user approves each flash.",
        {
          images: z.array(z.object({ path: z.string().min(1), offset: FlashOffset })).min(1).max(8),
          erase: z.boolean().optional(),
          port: SerialPort.optional(),
        },
        async ({ images, erase, port }) => {
          const offered = [];
          for (const img of images) {
            const full = resolve(cwd, img.path);
            try {
              const st = statSync(full);
              if (!st.isFile()) return asToolResult({ ok: false, text: `${full} is not a file.` });
              if (st.size > 32 * 1024 * 1024) return asToolResult({ ok: false, text: `${basename(full)} is over 32 MB, bigger than any ESP32's flash.` });
            } catch {
              return asToolResult({ ok: false, text: `${full} doesn't exist.` });
            }
            offered.push({ offset: img.offset, fileId: bridge.offerFile(full), name: basename(full) });
          }
          return run("esp_flash", { images: offered, ...(erase ? { erase } : {}), ...(port ? { port } : {}) }, 11 * 60_000);
        },
      ),
      tool(
        "mac_build",
        "Start one of the build jobs the user defined on their Mac for this project (e.g. a fast Android build), on the Mac's faster CPU with warm caches. " +
          "This session's working tree (git-tracked and new files) is mirrored to the Mac first, so build what you have here; you can't pass a command. " +
          "The build runs in the background and takes minutes: this returns as soon as it has started. When it ends, its result (exit code, the end of the log, " +
          "where the job's artifacts like the APK and full log were saved on this machine) arrives as a message in this conversation. " +
          "Meanwhile get on with other work. Don't sleep or poll waiting for it; if there is nothing else to do, end your turn and the result will start a new one. " +
          "mac_build_status shows how far it has got. " +
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
          const toolUseId = callIds.take(job);
          const already = builds.running(ctx.sessionId).find((b) => b.job === job);
          if (already) {
            return asToolResult({ ok: false, text: `${job} is already building (${describeBuild(already)}). Its result will arrive as a message; don't start it twice.` });
          }
          // Snapshot the tree now, so the build is of what's here at this moment.
          let manifest;
          try {
            manifest = await buildManifest(cwd);
          } catch (err) {
            return asToolResult({ ok: false, text: err instanceof ManifestError ? err.message : `Couldn't list the working tree: ${String(err)}` });
          }
          const project = ctx.project;
          const { id } = jobs.open(cwd, ctx.sessionId, manifest);
          const build = builds.start({
            sessionId: ctx.sessionId,
            toolUseId,
            job,
            run: (onProgress) =>
              bridge
                .call(
                  "run",
                  { jobId: id, project, job, manifest, ...(install ? { install } : {}), ...(serial ? { serial } : {}) },
                  // The Mac enforces the job's own timeout (60 min at most); this only covers a Mac gone quiet
                  // (its progress, including "waiting for another build", restarts it).
                  70 * 60_000,
                  onProgress,
                )
                .finally(() => jobs.close(id)),
          });
          return asToolResult({
            ok: true,
            text:
              `Started ${job} on ${st.name} as build ${build.id}. It runs in the background; its result will arrive as a message in this conversation when it ends. ` +
              "Carry on with anything else meanwhile, or end your turn if there's nothing else to do. Don't wait or poll for it.",
          });
        },
      ),
      tool(
        "mac_build_status",
        "How this session's Mac builds (started with mac_build) are getting on: what each is doing and for how long. Pass `build` for one build's full result once it has ended. " +
          "You don't need this to learn that a build finished; that arrives as a message by itself.",
        { build: z.string().max(40).optional() },
        async ({ build }) => {
          const mine = builds.forSession(ctx.sessionId);
          if (build) {
            const b = mine.find((x) => x.id === build);
            if (!b) return asToolResult({ ok: false, text: `No build "${build}" in this session.` });
            return asToolResult({ ok: true, text: b.result ? `${describeBuild(b)}\n\n${b.result.text}` : describeBuild(b) });
          }
          if (!mine.length) return asToolResult({ ok: true, text: "No Mac builds in this session (finished ones are forgotten after two hours)." });
          return asToolResult({ ok: true, text: mine.map((b) => `- ${describeBuild(b)}`).join("\n") });
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
export function createMacApprovalHook(callIds?: MacCallIds): HookCallbackMatcher {
  return {
    matcher: [...MAC_ASK_TOOLS, MAC_BUILD_TOOL].join("|"),
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse") return { continue: true };
        if (input.tool_name === MAC_BUILD_TOOL) callIds?.note(input.tool_use_id, input.tool_input);
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
