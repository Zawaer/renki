import { applyEvents, initialConversation, restoreBlockGaps } from "@renki/client-core";
import type { Session, SessionEvent } from "@renki/protocol";
import { renderMarkdown } from "./markdown.js";

/**
 * Longest history handed to a new conversation, in characters (~100k tokens).
 * Past this the oldest part is cut: the recent end is what the next prompt
 * is most likely about.
 */
const MAX_CONTEXT_CHARS = 400_000;

/**
 * A chat's history as a preamble for a new conversation — used when Claude's
 * own transcript is gone and the chat has to carry on without it. What was
 * said, from renki's log; tool calls, thinking and media are left out, since
 * they're the bulk and the replies already say what came of them.
 */
export function chatAsContext(session: Session, events: SessionEvent[]): string {
  const conv = restoreBlockGaps(applyEvents(initialConversation(session.id), events));
  const now = Date.now();
  let md = renderMarkdown(
    conv,
    { title: session.title?.trim() || "Untitled chat", repoName: session.repoId ? session.repoName : null, branch: session.branch, createdAt: session.createdAt, exportedAt: now },
    { media: false, tools: false, thinking: false, stats: false },
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
  if (md.length > MAX_CONTEXT_CHARS) md = `[…the earlier part of this chat is left out…]\n\n${md.slice(-MAX_CONTEXT_CHARS)}`;
  return [
    "This chat began in an earlier conversation whose transcript no longer exists, so you don't remember it. Here is what was said in it, as the app recorded it (tool calls left out), so you can carry on from it:",
    "",
    "<previous_chat>",
    md.trimEnd(),
    "</previous_chat>",
    "",
    "",
  ].join("\n");
}

/** The CLI's error when asked to resume a transcript it doesn't have. */
export function isLostConversation(errorMessage: string | null): boolean {
  return !!errorMessage && /No conversation found with session ID/i.test(errorMessage);
}
