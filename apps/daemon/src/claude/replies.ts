import { createSdkMcpServer, tool, type HookCallbackMatcher, type HookJSONOutput, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
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
  "write your reply as usual, ending on the question, then call suggest_replies as your very last action with the answers they're likely to give. The turn ends with that call, so the reply before it is your final message.",
  "Don't call it when you're not asking anything, when the answer needs the user's own words, or more than once per turn.",
  "The buttons are read on their own, often long after the options were explained: each label must name the choice itself (\"Name places by street\"), never refer to it by number or letter (\"Option 1\", \"Do 1 and 2\").",
].join(" ");

export function createRepliesMcpServer(): McpSdkServerConfigWithInstance {
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
