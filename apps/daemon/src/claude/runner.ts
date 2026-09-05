import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, CapabilitiesResponse, EventPayload, PermissionDecision } from "@crc/protocol";
import { logger } from "../logger.js";

/**
 * Translates the Agent SDK's typed message stream into our EventPayloads (which
 * the caller appends to the log), plus the shared types every caller of the
 * SDK needs. The process itself is owned by LiveClaudeSession
 * (./liveSession.ts): one long-lived `claude` child per session whose stdin
 * stays open between turns, so background agents survive the turn that
 * spawned them and their permission prompts still reach the controller.
 *
 * HISTORY: this used to spawn a fresh `query()` per prompt (resume-per-prompt)
 * to keep idle sessions free of the ~1 GiB an idle `claude` process costs.
 * That design had a hard limitation the SDK exposes as
 * anthropics/claude-agent-sdk-typescript#376 — the SDK closes the child's
 * stdin as soon as the first `result` arrives, after which every
 * permission-gated tool call from a still-running background subagent is
 * denied with "Stream closed", permanently. Keeping the input stream open for
 * the life of the session sidesteps that entirely; the memory cost is bounded
 * by SessionManager's idle reaper (CRC_LIVE_IDLE_MINUTES) instead.
 */

export type PermissionRequest = {
  requestId: string;
  turnId: string;
  toolName: string;
  toolInput: unknown;
  signal: AbortSignal;
};

export type PermissionOutcome = {
  decision: PermissionDecision;
  /** Which device answered (for the audit trail), or null if auto-resolved. */
  byDeviceId: string | null;
  /** Replaces the tool's original input on an "allow" (e.g. AskUserQuestion's answers). */
  updatedInput?: Record<string, unknown>;
};

/** Caller-supplied policy: decide (possibly by asking a remote controller). */
export type PermissionResolver = (req: PermissionRequest) => Promise<PermissionOutcome>;

export type RunTurnResult = {
  /** The Claude session id to persist for the NEXT resume (may be new). */
  claudeSessionId: string | null;
  ok: boolean;
  costUsd: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  /** True when the failure looks like an account usage/rate limit. */
  rateLimited: boolean;
  /** True when this failure is the controller stopping the turn, not a real error. */
  interrupted: boolean;
};

/** Pure heuristic: does this error text/flag indicate a usage/rate limit? */
export function classifyRateLimit(text: string | null | undefined): boolean {
  if (!text) return false;
  return /rate.?limit|usage limit|limit reached|limit exceeded|exceeded your usage|too many requests|429/i.test(text);
}

/** The non-string half of a user message's `content` — one image/document/text block. */
type UserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

/**
 * Turns one wire-format `Attachment` (always base64 on the wire, regardless of
 * kind) into the content block shape the Messages API expects. Images and PDFs
 * stay base64 (that's what their `source.type: "base64"` wants); a text file's
 * `PlainTextSource.data` wants the actual text, not base64, so that one case
 * decodes first.
 */
function attachmentToContentBlock(a: Attachment): UserContentBlock {
  if (a.mediaType === "text/plain") {
    return {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: Buffer.from(a.data, "base64").toString("utf-8") },
      title: a.name,
    };
  }
  if (a.mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: a.data },
      title: a.name,
    };
  }
  return { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } };
}

/**
 * The SDK's control-request channel (interrupt/setModel/supportedModels/
 * supportedCommands/etc.) only works in "streaming input" mode — passing
 * `prompt` as a plain string puts the query in a mode where those control
 * requests are unsupported and their promises never resolve. Wrapping the
 * same text (optionally preceded by attachment content blocks) as a
 * single-item async generator gets streaming-input mode without changing
 * anything else about a one-shot prompt.
 */
export async function* singlePromptStream(text: string, attachments?: Attachment[]): AsyncGenerator<SDKUserMessage> {
  yield buildUserMessage(text, attachments);
}

/** One prompt (text + optional attachments) as the SDK's user-message shape — shared by the one-shot and live paths. */
export function buildUserMessage(text: string, attachments?: Attachment[]): SDKUserMessage {
  const blocks = attachments?.map(attachmentToContentBlock) ?? [];
  // Images/documents before the text that references them, per Anthropic's own
  // guidance — matters for citations/grounding, not just cosmetics.
  const content = blocks.length === 0 ? text : text ? [...blocks, { type: "text" as const, text }] : blocks;
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

/** Per-(sub)agent block-index bookkeeping — see the comment on `agentTracking` in LiveClaudeSession. */
export type BlockTracking = {
  blockKinds: Map<number, "text" | "thinking" | "tool_use">;
  globalOffset: number;
  /** local block index -> when its first delta arrived, so a finished block can carry its own duration. */
  startedAt: Map<number, number>;
};

/** Terminal reasons the SDK uses for a turn cut short by `Query.interrupt()`. */
export function isInterruptedTerminalReason(reason: unknown): boolean {
  return reason === "aborted_streaming" || reason === "aborted_tools";
}

/**
 * Spins up a throwaway query purely to read supportedModels()/
 * supportedCommands() — the control-request channel resolves these as part
 * of the CLI's initial handshake, before the prompt is actually processed, so
 * aborting right after gives us the capability list without waiting for (or
 * paying for) a real response. Meant to be called once at daemon startup so
 * the picker isn't empty until the first real prompt happens to run.
 */
export async function warmUpCapabilities(cwd: string): Promise<CapabilitiesResponse | null> {
  const abortController = new AbortController();
  try {
    const q = query({
      prompt: singlePromptStream("(internal capability check — not a real prompt)"),
      options: { cwd, abortController },
    });
    const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()]);
    return { models, commands };
  } catch (err) {
    logger.warn("capabilities warm-up failed", { err: String(err) });
    return null;
  } finally {
    abortController.abort();
  }
}

/**
 * Translate a raw Anthropic streaming event into token-level deltas.
 *
 * We persist deltas (not just finished blocks) so a viewer who connects
 * mid-turn still replays the partial text token-by-token — that's the point of
 * event-sourcing the stream. The caller's `emit` (SessionManager) compacts
 * these away once the matching assistant_block lands, so they don't bloat the
 * log — see EventLog.compactBlock.
 */
export function handleStreamEvent(
  event: unknown,
  turnId: string,
  blockKinds: Map<number, "text" | "thinking" | "tool_use">,
  globalOffset: number,
  parentToolUseId: string | null,
  emit: (p: EventPayload) => void,
  startedAt?: Map<number, number>,
): void {
  const e = event as {
    type?: string;
    index?: number;
    content_block?: { type?: string };
    delta?: { type?: string; text?: string; thinking?: string };
  };

  if (e.type === "content_block_start" && typeof e.index === "number") {
    const t = e.content_block?.type;
    blockKinds.set(e.index, t === "thinking" ? "thinking" : t === "tool_use" ? "tool_use" : "text");
    startedAt?.set(e.index, Date.now());
    return;
  }

  if (e.type === "content_block_delta" && typeof e.index === "number") {
    const kind = blockKinds.get(e.index) ?? "text";
    const text = e.delta?.type === "text_delta" ? e.delta.text : e.delta?.type === "thinking_delta" ? e.delta.thinking : undefined;
    if (typeof text === "string" && text.length > 0) {
      emit({
        kind: "assistant_delta",
        turnId,
        blockIndex: globalOffset + e.index,
        blockKind: kind,
        text,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
    }
  }
}

/**
 * Emit a finished block per content item (canonical text / tool_use call).
 *
 * `message.content` is NOT guaranteed to line up 1:1 with the raw stream's own
 * content-block indices recorded in `blockKinds` — e.g. a thinking block can
 * be counted by the raw stream but be absent from this finalized content
 * array. Re-deriving indices via the array's own position (as opposed to
 * matching back against `blockKinds`) would then hand the same content a
 * DIFFERENT index than the one its streamed deltas already accumulated at,
 * leaving both the streamed and the canonical copy sitting in the reducer's
 * blocks array — i.e. the same answer rendered twice. Matching each content
 * item, in order, to the next `blockKinds` entry of the same kind keeps the
 * numbering identical to what handleStreamEvent already used.
 */
/** Identity of the (sub)agent a finalized assistant message came from — see handleAssistantMessage. */
export type SubagentContext = {
  parentToolUseId: string | null;
  subagentType?: string;
  taskDescription?: string;
};

export function handleAssistantMessage(
  message: unknown,
  turnId: string,
  blockKinds: Map<number, "text" | "thinking" | "tool_use">,
  globalOffset: number,
  subagentCtx: SubagentContext,
  emit: (p: EventPayload) => void,
  startedAt?: Map<number, number>,
): void {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  const localIndices = [...blockKinds.keys()].sort((a, b) => a - b);
  let cursor = 0;
  const subagentFields = subagentCtx.parentToolUseId
    ? {
        parentToolUseId: subagentCtx.parentToolUseId,
        ...(subagentCtx.subagentType ? { subagentType: subagentCtx.subagentType } : {}),
        ...(subagentCtx.taskDescription ? { taskDescription: subagentCtx.taskDescription } : {}),
      }
    : {};

  content.forEach((block: any) => {
    const kind: "text" | "thinking" | "tool_use" =
      block?.type === "thinking" ? "thinking" : block?.type === "tool_use" ? "tool_use" : "text";
    while (cursor < localIndices.length && blockKinds.get(localIndices[cursor]!) !== kind) cursor++;
    const localIndex = cursor < localIndices.length ? localIndices[cursor]! : localIndices.length;
    cursor++;
    const blockIndex = globalOffset + localIndex;
    const began = startedAt?.get(localIndex);
    const durationMs = began != null ? Math.max(0, Date.now() - began) : undefined;

    if (block?.type === "text") {
      emit({
        kind: "assistant_block",
        turnId,
        blockIndex,
        blockKind: "text",
        text: String(block.text ?? ""),
        toolUseId: null,
        toolName: null,
        toolInput: null,
        ...subagentFields,
      });
    } else if (block?.type === "thinking") {
      emit({
        kind: "assistant_block",
        turnId,
        blockIndex,
        blockKind: "thinking",
        text: String(block.thinking ?? ""),
        toolUseId: null,
        toolName: null,
        toolInput: null,
        ...(durationMs != null ? { durationMs } : {}),
        ...subagentFields,
      });
    } else if (block?.type === "tool_use") {
      emit({
        kind: "assistant_block",
        turnId,
        blockIndex,
        blockKind: "tool_use",
        text: null,
        toolUseId: String(block.id ?? ""),
        toolName: String(block.name ?? ""),
        toolInput: block.input ?? null,
        ...subagentFields,
      });
    }
  });
}

/** A `user` SDK message carries tool_result blocks for tools the SDK ran. */
export function handleToolResults(message: unknown, turnId: string, emit: (p: EventPayload) => void): void {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  for (const block of content as any[]) {
    if (block?.type !== "tool_result") continue;
    emit({
      kind: "tool_result",
      turnId,
      toolUseId: String(block.tool_use_id ?? ""),
      ok: block.is_error !== true,
      summary: summarizeToolResult(block.content),
    });
  }
}

function summarizeToolResult(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
  else text = JSON.stringify(content ?? "");
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export function summarizeResultError(message: { subtype: string; errors?: string[]; result?: string }): string {
  if (message.errors && message.errors.length > 0) return message.errors.join("; ");
  // The "success"-shaped result variant (subtype: "success", is_error: true) has no
  // `errors` array — e.g. account-level failures like hitting a spend limit — but its
  // `result` field carries the human-readable message. Falling through to `subtype`
  // there would just render the literal string "success" as the error.
  if (typeof message.result === "string" && message.result.trim().length > 0) return message.result;
  return message.subtype;
}
