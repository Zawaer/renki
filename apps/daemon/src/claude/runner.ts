import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { EventPayload, PermissionDecision } from "@crc/protocol";
import { logger } from "../logger.js";
import { newTurnId } from "../ids.js";

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
  promptId: string;
  /** Append an event to the session's log (the runner's only output channel). */
  emit: (payload: EventPayload) => void;
  resolvePermission: PermissionResolver;
  abortController?: AbortController;
  model?: string;
  /** If true, don't load ~/.claude settings so every gated tool asks the controller. */
  forcePermissionPrompts?: boolean;
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
};

/** Pure heuristic: does this error text/flag indicate a usage/rate limit? */
export function classifyRateLimit(text: string | null | undefined): boolean {
  if (!text) return false;
  return /rate.?limit|usage limit|limit reached|limit exceeded|exceeded your usage|too many requests|429/i.test(text);
}

export async function runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
  const turnId = newTurnId();
  let claudeSessionId: string | null = args.resumeSessionId;
  let sawRateLimitError = false;
  const blockKinds = new Map<number, "text" | "thinking" | "tool_use">();

  const options: Options = {
    cwd: args.cwd,
    includePartialMessages: true,
    permissionMode: "default",
    abortController: args.abortController,
    ...(args.resumeSessionId ? { resume: args.resumeSessionId } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.forcePermissionPrompts ? { settingSources: [] } : {}),
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
    for await (const message of query({ prompt: args.prompt, options })) {
      // Every SDK message carries the session id; keep the latest so we can
      // resume next time even if the id was freshly minted this turn.
      if ("session_id" in message && message.session_id) claudeSessionId = message.session_id;

      switch (message.type) {
        case "stream_event":
          handleStreamEvent(message.event, turnId, blockKinds, args.emit);
          break;

        case "assistant":
          if ((message as { error?: string }).error === "rate_limit") sawRateLimitError = true;
          handleAssistantMessage(message.message, turnId, args.emit);
          break;

        case "user":
          handleToolResults(message.message, turnId, args.emit);
          break;

        case "result": {
          const ok = message.subtype === "success" && !message.is_error;
          const errorMessage = ok ? null : summarizeResultError(message);
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
          });
          return {
            claudeSessionId,
            ok,
            costUsd: message.total_cost_usd ?? null,
            durationMs: message.duration_ms ?? null,
            errorMessage,
            rateLimited: !ok && (sawRateLimitError || classifyRateLimit(errorMessage)),
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
  };
}

/**
 * Translate a raw Anthropic streaming event into token-level deltas.
 *
 * We persist deltas (not just finished blocks) so a viewer who connects
 * mid-turn still replays the partial text token-by-token — that's the point of
 * event-sourcing the stream. FUTURE: compact deltas away once the matching
 * assistant_block lands, to keep the log small.
 */
function handleStreamEvent(
  event: unknown,
  turnId: string,
  blockKinds: Map<number, "text" | "thinking" | "tool_use">,
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
      emit({ kind: "assistant_delta", turnId, blockIndex: e.index, blockKind: kind, text });
    }
  }
}

/** Emit a finished block per content item (canonical text / tool_use call). */
function handleAssistantMessage(message: unknown, turnId: string, emit: (p: EventPayload) => void): void {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  content.forEach((block: any, blockIndex: number) => {
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

function summarizeResultError(message: { subtype: string; errors?: string[] }): string {
  if (message.errors && message.errors.length > 0) return message.errors.join("; ");
  return message.subtype;
}
