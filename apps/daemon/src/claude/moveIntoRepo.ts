import { tool, type HookCallbackMatcher, type HookJSONOutput, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { RENKI_SERVER } from "./replies.js";

/**
 * `move_into_repo`: a repo-less chat asks to be moved into a repo, the way the
 * user would with "Move into repo…". Offered only to chats without a repo.
 *
 * Moving changes what the chat may do (homelab access and Mac jobs are per
 * repo), so the call always asks the user, in every permission mode
 * (createMoveIntoRepoHook), and the approval card names the repo. The move
 * itself can't happen mid-turn (the process restarts in the new folder), so
 * the tool only books it; the manager carries it out once the chat is idle.
 */

export const MOVE_INTO_REPO_TOOL = `mcp__${RENKI_SERVER}__move_into_repo`;

export type MoveRequester = (repo: string) => Promise<{ ok: boolean; text: string }>;
/** What the approval card should add about the move, e.g. that the repo lacks homelab access the chat has now. */
export type MoveNote = (repo: string) => Promise<string | null>;

export function createMoveIntoRepoTool(request: MoveRequester): SdkMcpToolDefinition<{ repo: z.ZodString }> {
  return tool(
    "move_into_repo",
    "Move this chat into a git repo, like the user's \"Move into repo…\" button: from the next turn on you work in a fresh checkout of the repo, " +
      "on this chat's own branch, with the whole conversation kept. `repo` is a GitHub repo (owner/name or a github.com URL; cloned if Renki doesn't have it yet) " +
      "or the name of a repo Renki already has. Use it when the user asks to move the chat, or once a repo you created for this work exists and has its first push. " +
      "The user approves it. The move happens right after this turn ends, so call it last and end your turn; files in this chat's current folder stay where they are, " +
      "so commit and push anything the repo needs first.",
    { repo: z.string().trim().min(1).max(200) },
    async ({ repo }) => {
      const r = await request(repo);
      return { content: [{ type: "text" as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );
}

/** Ask before every move, even in Auto or bypass mode: it changes which repo's access rules apply. */
export function createMoveIntoRepoHook(note?: MoveNote): HookCallbackMatcher {
  return {
    matcher: MOVE_INTO_REPO_TOOL,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== MOVE_INTO_REPO_TOOL) return { continue: true };
        const repo = (input.tool_input as { repo?: unknown } | null)?.repo;
        const extra = typeof repo === "string" && note ? await note(repo).catch(() => null) : null;
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `Move this chat into ${typeof repo === "string" ? repo : "a repo"}.${extra ? ` ${extra}` : ""}`,
          },
        };
      },
    ],
  };
}
