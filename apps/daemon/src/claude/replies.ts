import { createSdkMcpServer, tool, type HookCallbackMatcher, type HookJSONOutput, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * The `renki` MCP server every session gets: `suggest_replies`, the buttons
 * under a reply that ends on a question ("Want me to deploy?" → "Yes, deploy").
 *
 * Unlike AskUserQuestion it never blocks: the call returns at once, the turn
 * ends, and nothing is left pending for a restart to strand. The clients read
 * the replies straight from the tool call in the transcript and send the one
 * picked as the user's next message, so the daemon keeps no state for it.
 *
 * Always loaded rather than behind tool search, because it's only useful if
 * Claude has it in mind at the end of every turn.
 *
 * Claude calls it after its reply, and createRepliesStopHook ends the turn
 * right there. Left to carry on, Claude wanted to end on text that stands on
 * its own, so it wrote the whole answer again under the buttons; asked to
 * call it before the reply instead, it drafted the answer in its thinking and
 * replied with only the question.
 */

export const RENKI_SERVER = "renki";
export const SUGGEST_REPLIES_TOOL = `mcp__${RENKI_SERVER}__suggest_replies`;

/** Button labels: short enough to fit a phone's row of two or three. */
const Reply = z.string().trim().min(1).max(40);
/** The question shown above the buttons, so they make sense without scrolling back. */
const Question = z.string().trim().min(1).max(100);

const INSTRUCTIONS = [
  "The user reads this session in Renki, often on a phone, where typing is slow.",
  "When you end a turn waiting on a short decision from the user (a yes/no, or a pick between two or three next steps),",
  // The full name: told only "suggest_replies", Claude once guessed it lived on
  // the mac server, got "No such tool", and wrote its whole answer again.
  `write your reply as usual, ending on the question, then call ${SUGGEST_REPLIES_TOOL} (on the ${RENKI_SERVER} server, not any other) as your very last action with the answers they're likely to give. The turn ends with that call, so the reply before it is your final message.`,
  "Finish all other work (edits, commits, file writes) before writing that reply, and spell out in the reply itself what each choice means: a file you wrote doesn't count, the user only sees the reply and the buttons.",
  "Don't call it when you're not asking anything, when the answer needs the user's own words, or more than once per turn.",
  "The buttons are read on their own, often long after the options were explained: each label must name the choice itself (\"Name places by street\"), never refer to it by number or letter (\"Option 1\", \"Do 1 and 2\").",
].join(" ");

/** `extraTools`: per-session tools served on the same `renki` server (e.g. move_into_repo). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRepliesMcpServer(extraTools: SdkMcpToolDefinition<any>[] = []): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: RENKI_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    alwaysLoad: true,
    tools: [
      tool(
        "suggest_replies",
        "Show the user one-tap answers to the question your reply ends on. `question` is that question in a few words, shown above the buttons (\"How should places be named?\"). Each reply is a button label that is also sent, as written, as the user's next message: phrase it in the user's voice (\"Yes, deploy it\", \"Keep them\"), at most 40 characters, the likeliest first, and make it name the choice itself, never \"Option 1\". 1 to 3 replies. Call it last, after your reply: the turn ends with it.",
        { question: Question, replies: z.array(Reply).min(1).max(3) },
        async () => ({
          content: [{ type: "text" as const, text: "Shown to the user as buttons under your reply. Their answer arrives as their next message." }],
        }),
        { annotations: { readOnlyHint: true } },
      ),
      ...extraTools,
    ],
  });
}

/**
 * Ends the turn once suggest_replies has run, so Claude doesn't get another go
 * at writing (see the top of this file). Only on the main thread: a subagent
 * calling it shouldn't cut its parent's turn short.
 */
export function createRepliesStopHook(): HookCallbackMatcher {
  return {
    matcher: SUGGEST_REPLIES_TOOL,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PostToolUse" || input.tool_name !== SUGGEST_REPLIES_TOOL || input.agent_id) return { continue: true };
        return { continue: false, stopReason: "Suggested replies shown" };
      },
    ],
  };
}

/**
 * Refuses suggest_replies when no reply text was written since the last tool
 * call. Claude sometimes answered in its thinking, which the user reads as a
 * grey aside, or wrote its reply and then kept working, which turns that reply
 * into mid-turn narration; either way the buttons sat under nothing. Told so,
 * it writes the reply and calls again. Main thread only, like the stop hook.
 */
export function createRepliesGuardHook(hasReply: () => boolean): HookCallbackMatcher {
  return {
    matcher: SUGGEST_REPLIES_TOOL,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== SUGGEST_REPLIES_TOOL || input.agent_id) return { continue: true };
        if (hasReply()) return { continue: true };
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              `Not shown: there's no reply above the buttons. The user can't see your thinking, and text written before a tool call reads as progress. Write your reply now as plain text, explaining each choice, then call ${SUGGEST_REPLIES_TOOL} again.`,
          },
        };
      },
    ],
  };
}

/**
 * Whether a main-thread stream event settles "is there a reply since the last
 * tool call": true for visible text, false for a tool call other than
 * suggest_replies, undefined for anything else.
 */
export function replyStateAfter(event: unknown): boolean | undefined {
  const e = event as { type?: string; content_block?: { type?: string; name?: string }; delta?: { type?: string; text?: string } };
  if (e.type === "content_block_start" && e.content_block?.type === "tool_use") return e.content_block.name === SUGGEST_REPLIES_TOOL ? undefined : false;
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text?.trim()) return true;
  return undefined;
}
