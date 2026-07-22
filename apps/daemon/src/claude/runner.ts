import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, CapabilitiesResponse, EventPayload, PermissionDecision } from "@crc/protocol";
import { logger } from "../logger.js";
import { newTurnId } from "../ids.js";
import { createRtkPreToolUseHook } from "./rtk.js";

/**
 * Runs a single Claude turn via the Agent SDK and translates the SDK's typed
 * message stream into our EventPayloads (which the caller appends to the log).
 *
 * WHY resume-per-prompt (fresh query each turn) instead of one long-lived
 * subprocess: the SDK spawns a `claude` child process per query and Anthropic
 * suggests budgeting ~1 GiB RAM per concurrent session. If we held a process
 * open for every session, idle sessions would eat memory and cap how many can
 * exist. Instead we resume the persisted `claudeSessionId` for each prompt, so
 * an idle session costs nothing but a DB row + a worktree on disk. Conversation
 * context isn't lost — it lives in the resumable transcript, not the process.
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
};

/** Caller-supplied policy: decide (possibly by asking a remote controller). */
export type PermissionResolver = (req: PermissionRequest) => Promise<PermissionOutcome>;

export type RunTurnArgs = {
  cwd: string;
  /** Prior Claude session id to resume, or null to start a fresh conversation. */
  resumeSessionId: string | null;
  prompt: string;
  /** Images/PDFs/text files attached to this prompt, if any — see singlePromptStream. */
  attachments?: Attachment[];
  promptId: string;
  /** Append an event to the session's log (the runner's only output channel). */
  emit: (payload: EventPayload) => void;
  resolvePermission: PermissionResolver;
  abortController?: AbortController;
  model?: string;
  /** Thinking-token budget for this turn; omit/null for the SDK's own default. */
  maxThinkingTokens?: number | null;
  /** SDK permission mode for this turn; omit for `"default"` (ask for every gated tool). */
  permissionMode?: Options["permissionMode"];
  /** If true, don't load ~/.claude settings so every gated tool asks the controller. */
  forcePermissionPrompts?: boolean;
  /** If true, rewrite Bash commands through RTK (see ./rtk.ts) before they run. */
  enableRtk?: boolean;
  /** `rtk` executable to invoke when enableRtk is set (name on PATH or absolute path). */
  rtkBin?: string;
  /**
   * Only obtainable from a live Query object, so the caller opts in (once,
   * when it doesn't already have this cached daemon-wide) rather than paying
   * for the extra control-request round-trip on every single turn.
   */
  onCapabilities?: (caps: CapabilitiesResponse) => void;
  /**
   * Handed the live Query object the instant it's created (before any message
   * is consumed), so the caller can stash it and later call `.interrupt()` —
   * the only way to stop a turn already in flight. Called synchronously, so
   * the caller never has to worry about racing a turn's start.
   */
  onQuery?: (q: Query) => void;
};

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

/** Terminal reasons the SDK uses for a turn cut short by `Query.interrupt()`. */
function isInterruptedTerminalReason(reason: unknown): boolean {
  return reason === "aborted_streaming" || reason === "aborted_tools";
}

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
  const blocks = attachments?.map(attachmentToContentBlock) ?? [];
  // Images/documents before the text that references them, per Anthropic's own
  // guidance — matters for citations/grounding, not just cosmetics.
  const content = blocks.length === 0 ? text : text ? [...blocks, { type: "text" as const, text }] : blocks;
  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

export async function runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
  const turnId = newTurnId();
  let claudeSessionId: string | null = args.resumeSessionId;
  let sawRateLimitError = false;
  // Anthropic's raw stream numbers content blocks PER underlying model call —
  // a tool round-trip starts a brand-new message whose own blocks count from
  // 0 again. blockKinds tracks only the CURRENT message's local indices;
  // globalOffset (bumped after each "assistant" message, see below) turns
  // those into stable, turn-wide positions so a multi-message turn's blocks
  // don't collide and overwrite each other.
  let blockKinds = new Map<number, "text" | "thinking" | "tool_use">();
  let globalOffset = 0;

  const options: Options = {
    cwd: args.cwd,
    includePartialMessages: true,
    permissionMode: args.permissionMode ?? "default",
    abortController: args.abortController,
    ...(args.resumeSessionId ? { resume: args.resumeSessionId } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.maxThinkingTokens != null ? { maxThinkingTokens: args.maxThinkingTokens } : {}),
    ...(args.forcePermissionPrompts ? { settingSources: [] } : {}),
    ...(args.enableRtk ? { hooks: { PreToolUse: [createRtkPreToolUseHook(args.rtkBin ?? "rtk")] } } : {}),
    // Route every permission decision through the caller's resolver. This only
    // fires for tools the permission system doesn't auto-resolve (edits, bash,
    // etc.), which is exactly the set a human controller should see.
    canUseTool: async (toolName, input, opts): Promise<PermissionResult> => {
      const requestId = opts.toolUseID;
      args.emit({ kind: "permission_request", requestId, turnId, toolName, toolInput: input });
      const { decision, byDeviceId } = await args.resolvePermission({
        requestId,
        turnId,
        toolName,
        toolInput: input,
        signal: opts.signal,
      });
      args.emit({ kind: "permission_resolved", requestId, decision, byDeviceId });

      return decision === "allow"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Denied by controller." };
    },
    // Surface the child process's stderr into our logs for debuggability.
    stderr: (data: string) => logger.debug("claude stderr", { data: data.slice(0, 500) }),
  };

  try {
    const q = query({ prompt: singlePromptStream(args.prompt, args.attachments), options });
    args.onQuery?.(q);

    // supportedModels()/supportedCommands() only exist on a LIVE Query object,
    // so this is the one place we can ever discover them. Runs concurrently
    // with the message loop below (a separate control-request channel, not
    // blocking) — best-effort, a failure here shouldn't fail the turn.
    if (args.onCapabilities) {
      const onCapabilities = args.onCapabilities;
      Promise.all([q.supportedModels(), q.supportedCommands()])
        .then(([models, commands]) => onCapabilities({ models, commands }))
        .catch((err) => logger.warn("supportedModels/supportedCommands failed", { err: String(err) }));
    }

    for await (const message of q) {
      // Every SDK message carries the session id; keep the latest so we can
      // resume next time even if the id was freshly minted this turn.
      if ("session_id" in message && message.session_id) claudeSessionId = message.session_id;

      switch (message.type) {
        case "stream_event":
          handleStreamEvent(message.event, turnId, blockKinds, globalOffset, args.emit);
          break;

        case "assistant": {
          if ((message as { error?: string }).error === "rate_limit") sawRateLimitError = true;
          handleAssistantMessage(message.message, turnId, blockKinds, globalOffset, args.emit);
          // This message is done — its local indices are now spoken for.
          // Shift the next message's (which will again start counting from 0)
          // past them.
          const maxLocal = blockKinds.size > 0 ? Math.max(...blockKinds.keys()) : -1;
          globalOffset += maxLocal + 1;
          blockKinds = new Map();
          break;
        }

        case "user":
          handleToolResults(message.message, turnId, args.emit);
          break;

        case "result": {
          const ok = message.subtype === "success" && !message.is_error;
          const interrupted = !ok && isInterruptedTerminalReason((message as { terminal_reason?: unknown }).terminal_reason);
          const errorMessage = ok ? null : interrupted ? "Stopped by controller." : summarizeResultError(message);
          args.emit({
            kind: "turn_result",
            turnId,
            promptId: args.promptId,
            ok,
            costUsd: message.total_cost_usd ?? null,
            durationMs: message.duration_ms ?? null,
            errorMessage,
            inputTokens: message.usage?.input_tokens ?? null,
            outputTokens: message.usage?.output_tokens ?? null,
            interrupted,
          });
          return {
            claudeSessionId,
            ok,
            costUsd: message.total_cost_usd ?? null,
            durationMs: message.duration_ms ?? null,
            errorMessage,
            rateLimited: !ok && (sawRateLimitError || classifyRateLimit(errorMessage)),
            interrupted,
          };
        }

        default:
          // system/init, tool_progress, status, etc. — not modeled in v1.
          break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("turn failed", { turnId, err: msg });
    args.emit({
      kind: "turn_result",
      turnId,
      promptId: args.promptId,
      ok: false,
      costUsd: null,
      durationMs: null,
      errorMessage: msg,
      inputTokens: null,
      outputTokens: null,
    });
    return {
      claudeSessionId,
      ok: false,
      costUsd: null,
      durationMs: null,
      errorMessage: msg,
      rateLimited: sawRateLimitError || classifyRateLimit(msg),
      interrupted: false,
    };
  }

  // Generator ended without a `result` message (shouldn't normally happen).
  return {
    claudeSessionId,
    ok: false,
    costUsd: null,
    durationMs: null,
    errorMessage: "no result message",
    rateLimited: false,
    interrupted: false,
  };
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
 * event-sourcing the stream. FUTURE: compact deltas away once the matching
 * assistant_block lands, to keep the log small.
 */
export function handleStreamEvent(
  event: unknown,
  turnId: string,
  blockKinds: Map<number, "text" | "thinking" | "tool_use">,
  globalOffset: number,
  emit: (p: EventPayload) => void,
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
    return;
  }

  if (e.type === "content_block_delta" && typeof e.index === "number") {
    const kind = blockKinds.get(e.index) ?? "text";
    const text = e.delta?.type === "text_delta" ? e.delta.text : e.delta?.type === "thinking_delta" ? e.delta.thinking : undefined;
    if (typeof text === "string" && text.length > 0) {
      emit({ kind: "assistant_delta", turnId, blockIndex: globalOffset + e.index, blockKind: kind, text });
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
export function handleAssistantMessage(
  message: unknown,
  turnId: string,
  blockKinds: Map<number, "text" | "thinking" | "tool_use">,
  globalOffset: number,
  emit: (p: EventPayload) => void,
): void {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  const localIndices = [...blockKinds.keys()].sort((a, b) => a - b);
  let cursor = 0;

  content.forEach((block: any) => {
    const kind: "text" | "thinking" | "tool_use" =
      block?.type === "thinking" ? "thinking" : block?.type === "tool_use" ? "tool_use" : "text";
    while (cursor < localIndices.length && blockKinds.get(localIndices[cursor]!) !== kind) cursor++;
    const localIndex = cursor < localIndices.length ? localIndices[cursor]! : localIndices.length;
    cursor++;
    const blockIndex = globalOffset + localIndex;

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
      });
    }
  });
}

/** A `user` SDK message carries tool_result blocks for tools the SDK ran. */
function handleToolResults(message: unknown, turnId: string, emit: (p: EventPayload) => void): void {
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
