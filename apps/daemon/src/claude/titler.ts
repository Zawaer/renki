import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";
import { getCapabilities } from "./capabilities.js";
import { singlePromptStream } from "./runner.js";

const FALLBACK_MODEL = "claude-haiku-4-5-20251001";

/** Model replies with exactly this when the transcript so far isn't enough to title specifically. */
const NOT_ENOUGH_CONTEXT = "NONE";

const TITLE_SYSTEM_PROMPT =
  "You generate short titles for coding chat sessions, like a browser tab title. " +
  "You'll be shown the conversation so far (user messages and a trimmed version of the assistant's replies). " +
  "Write a specific, descriptive title for what's being discussed or worked on — use the assistant's replies " +
  "for detail even if the user's own messages are vague (e.g. \"what does this do\"). " +
  `Only reply with exactly "${NOT_ENOUGH_CONTEXT}" if there's truly nothing to go on yet (e.g. just a greeting). ` +
  "Otherwise reply with ONLY the title: 3-6 words, no punctuation, no quotes, no markdown.";

/** Cheapest model available for a disposable side task like this; falls back to a known-cheap id. */
function pickCheapModel(): string {
  const match = getCapabilities().models.find((m) => /haiku/i.test(m.value) || /haiku/i.test(m.displayName));
  return match?.value ?? FALLBACK_MODEL;
}

function truncate(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}…` : cleaned;
}

/** Instant, LLM-free title from the raw first prompt — shown immediately, upgraded later if `generateSessionTitle` finds something better. */
export function derivePlaceholderTitle(firstPrompt: string): string {
  return truncate(firstPrompt) || "New session";
}

function sanitizeGenerated(raw: string): string | null {
  const cleaned = raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ");
  if (!cleaned || cleaned.toUpperCase() === NOT_ENOUGH_CONTEXT) return null;
  return cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}…` : cleaned;
}

/**
 * Spins up a throwaway, tool-less turn purely to summarize the conversation
 * so far into a short title (same auth/subprocess path as a real turn, see
 * runner.ts — there's no separate API key to call Anthropic directly).
 * Capped to one no-tool round trip on the cheapest available model. Returns
 * null both on failure AND when the model decides there isn't enough context
 * yet — callers should treat either as "try again next turn",
 * not a fatal error.
 */
export async function generateSessionTitle(cwd: string, transcriptSoFar: string): Promise<string | null> {
  try {
    const q = query({
      prompt: singlePromptStream(transcriptSoFar),
      options: {
        cwd,
        model: pickCheapModel(),
        systemPrompt: TITLE_SYSTEM_PROMPT,
        tools: [],
        maxTurns: 1,
      },
    });

    let text = "";
    for await (const message of q) {
      if (message.type !== "assistant") continue;
      const content = (message.message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content as any[]) {
        if (block?.type === "text" && typeof block.text === "string") text += block.text;
      }
    }
    return sanitizeGenerated(text);
  } catch (err) {
    logger.warn("title generation failed", { err: String(err) });
    return null;
  }
}
