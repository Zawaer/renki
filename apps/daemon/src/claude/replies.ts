import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
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
 * Claude calls it just before its final reply, not after: a tool call gives
 * Claude another go, and Claude Code ends a turn on text that stands on its
 * own, so a reply written first came out twice (the whole answer again,
 * after the buttons). The clients only need it to be the turn's last call.
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
  "call suggest_replies with the answers they're likely to give once your work is done, then write your reply as usual, ending on that question. The reply after the call is your one final message: don't write it before the call too, and make no more tool calls after it.",
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
        "Show the user one-tap answers to the question your reply ends on. `question` is that question in a few words, shown above the buttons (\"How should places be named?\"). Each reply is a button label that is also sent, as written, as the user's next message: phrase it in the user's voice (\"Yes, deploy it\", \"Keep them\"), at most 40 characters, the likeliest first, and make it name the choice itself, never \"Option 1\". 1 to 3 replies. Call it after your last other tool call and before your final reply, then write that reply once and end your turn.",
        { question: Question, replies: z.array(Reply).min(1).max(3) },
        async () => ({
          content: [{ type: "text" as const, text: "The buttons will show under your reply. Now write your final reply, ending on that question, and end your turn without more tool calls: their answer arrives as their next message." }],
        }),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
