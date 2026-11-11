import { tool, type HookCallbackMatcher, type HookJSONOutput, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { RENKI_SERVER } from "./replies.js";

/**
 * `request_homelab_access`: a chat whose project is off in Settings > Homelab
 * access asks for it to be turned on, instead of stopping and sending the user
 * to Settings. The call always asks the user, in every permission mode
 * (createHomelabAccessHook), so nothing the chat says widens access without the
 * user's tap. Approving turns the project on in Settings, the same switch.
 */

export const REQUEST_HOMELAB_ACCESS_TOOL = `mcp__${RENKI_SERVER}__request_homelab_access`;

export type HomelabAccessRequester = () => Promise<{ ok: boolean; text: string }>;

export function createHomelabAccessTool(request: HomelabAccessRequester): SdkMcpToolDefinition<{ why: z.ZodString }> {
  return tool(
    "request_homelab_access",
    "Ask the user to turn on homelab access for this project (Settings > Homelab access), when a `homelab` command was refused because it's off. " +
      "`why` is one short line on what you want to do, shown on the approval card (e.g. \"Deploy the findmy server and give it an address\"). " +
      "Once approved, run the refused command again and carry on.",
    { why: z.string().trim().min(1).max(200) },
    async () => {
      const r = await request();
      return { content: [{ type: "text" as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );
}

/** Ask before every request, even in Auto or bypass mode: approving widens what the chat may do. */
export function createHomelabAccessHook(project: () => string): HookCallbackMatcher {
  return {
    matcher: REQUEST_HOMELAB_ACCESS_TOOL,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== REQUEST_HOMELAB_ACCESS_TOOL) return { continue: true };
        const why = (input.tool_input as { why?: unknown } | null)?.why;
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `Turn on homelab access for ${project()}.${typeof why === "string" && why.trim() ? ` ${why.trim().replace(/\.?$/, ".")}` : ""}`,
          },
        };
      },
    ],
  };
}
