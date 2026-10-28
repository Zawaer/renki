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
 */

export const RENKI_SERVER = "renki";
export const SUGGEST_REPLIES_TOOL = `mcp__${RENKI_SERVER}__suggest_replies`;

/** Button labels: short enough to fit a phone's row of two or three. */
const Reply = z.string().trim().min(1).max(40);

const INSTRUCTIONS = [
  "The user reads this session in Renki, often on a phone, where typing is slow.",
  "When you end a turn waiting on a short decision from the user (a yes/no, or a pick between two or three next steps),",
  "write your reply as usual, ending on the question, then call suggest_replies as your very last action with the answers they're likely to give.",
  "Don't call it when you're not asking anything, when the answer needs the user's own words, or more than once per turn.",
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
        "Show the user one-tap answers to the question your reply ends on. Each reply is a button label that is also sent, as written, as the user's next message: phrase it in the user's voice (\"Yes, deploy it\", \"Keep them\"), at most 40 characters, the likeliest first. 1 to 3 replies. Call it last, then end your turn.",
        { replies: z.array(Reply).min(1).max(3) },
        async () => ({
          content: [{ type: "text" as const, text: "Shown to the user as buttons. End your turn now: their answer arrives as their next message." }],
        }),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
