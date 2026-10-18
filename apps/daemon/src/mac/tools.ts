import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createSdkMcpServer, tool, type HookCallbackMatcher, type HookJSONOutput, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { AdbSerial, MacVerbArgs, type MacVerb } from "@renki/protocol";
import { z } from "zod";
import type { MacBridge, MacResult } from "./bridge.js";

/**
 * The `mac` MCP server every allowed session gets: the phone plugged into the
 * user's Mac, reached through the Mac bridge (./bridge.ts). Registered whether
 * or not a Mac is attached right now, since a live session outlives many
 * connects and disconnects; an offline Mac answers each call with how to fix it.
 *
 * Reading the phone (devices, screenshot, logcat) and tapping/typing on it run
 * without asking. A free phone shell and installing an APK ask the controller
 * first, in every permission mode (see createMacApprovalHook).
 */

export const MAC_SERVER = "mac";
const tid = (name: string) => `mcp__${MAC_SERVER}__${name}`;

/** Tools that change what is on the phone; these always ask. */
export const MAC_ASK_TOOLS = [tid("phone_shell"), tid("phone_install_apk")];
/** Tools that only look or tap; allowed without asking. */
export const MAC_FREE_TOOLS = [tid("phone_devices"), tid("phone_screenshot"), tid("phone_logcat"), tid("phone_input")];

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

export function createMacMcpServer(bridge: MacBridge, cwd: string): McpSdkServerConfigWithInstance {
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
    matcher: MAC_ASK_TOOLS.join("|"),
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse" || !MAC_ASK_TOOLS.includes(input.tool_name)) return { continue: true };
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
