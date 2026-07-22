import type { SessionEvent, SessionStatus } from "@crc/protocol";

/**
 * The event-log → view-state reducer. This is the piece that makes every client
 * identical: feed it the same ordered SessionEvents (whether from a cold replay
 * or a live stream — they're the same events) and it produces the same
 * ConversationState. No client ever asks "what's the current state?"; it folds
 * the log. That's why reconnecting can't desync — you replay the missed events
 * through this same function and arrive at exactly the right place.
 *
 * Pure and DOM-free on purpose: React (web/VS Code) and React Native (Android)
 * all consume the same output.
 */

export type BlockView =
  | { kind: "text" | "thinking"; text: string; startedAtMs: number | null; endedAtMs: number | null }
  | {
      kind: "tool_use";
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      result: { ok: boolean; summary: string } | null;
    };

export type TurnView = {
  turnId: string;
  promptId: string | null;
  /** Ordered by the block index Claude assigned. */
  blocks: BlockView[];
  status: "running" | "done" | "error";
  costUsd: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  /** Real usage from the SDK's result message — only known once the turn finishes. */
  inputTokens: number | null;
  outputTokens: number | null;
};

/** A prompt the controller sent, an assistant turn, or a system notice. */
export type TimelineItem =
  | { type: "prompt"; promptId: string; deviceId: string; text: string }
  | { type: "turn"; turn: TurnView }
  | { type: "notice"; text: string; level: "info" | "warn" };

export type PermissionView = {
  requestId: string;
  turnId: string;
  toolName: string;
  toolInput: unknown;
};

/** A prompt sent while the session was busy, waiting its turn — not yet running. */
export type QueuedPromptView = {
  promptId: string;
  deviceId: string;
  text: string;
};

export type ConversationState = {
  sessionId: string;
  status: SessionStatus | null;
  controller: string | null;
  controllerName: string | null;
  repoName: string | null;
  branch: string | null;
  timeline: TimelineItem[];
  /** Permission requests awaiting a decision, in arrival order. */
  pending: PermissionView[];
  /**
   * Prompts queued behind a busy turn, in send order. Deliberately kept OUT of
   * `timeline` — a queued prompt renders eagerly (this list) the instant it's
   * sent, but its own turn doesn't start until earlier ones finish. If a
   * follow-up got typed faster than the model replies, appending it straight
   * into `timeline` would put its bubble ahead of the turn it's replying to,
   * desyncing every prompt/answer pair after it. Keeping queued prompts in
   * their own list — and only moving one into `timeline` (see
   * `prompt_submitted`) once it actually starts running — means `timeline`
   * stays what it always was: strictly ordered prompt/answer pairs.
   */
  queuedPrompts: QueuedPromptView[];
  /** Highest seq folded in — sent as lastSeq on (re)subscribe. */
  lastSeq: number;
};

export function initialConversation(sessionId: string): ConversationState {
  return {
    sessionId,
    status: null,
    controller: null,
    controllerName: null,
    repoName: null,
    branch: null,
    timeline: [],
    pending: [],
    queuedPrompts: [],
    lastSeq: -1,
  };
}

/**
 * Fold one event into state, returning a NEW state object (never mutates prev).
 *
 * Events with `seq <= prev.lastSeq` are dropped as already-folded. This makes
 * folding idempotent, which matters because seq is the only thing that lets a
 * reconnect ask for "everything after lastSeq" — if the same event ever
 * reaches a client twice (overlapping replay ranges from a double subscribe,
 * a redelivered live event, etc.) re-applying it would double-count: an
 * appended timeline item (prompt/notice) would render twice, and an
 * accumulating block (assistant_delta) would append its text a second time.
 */
export function applyEvent(prev: ConversationState, e: SessionEvent): ConversationState {
  if (e.seq <= prev.lastSeq) return prev;
  const s: ConversationState = { ...prev, lastSeq: e.seq };

  switch (e.kind) {
    case "session_created":
      s.repoName = e.repoName;
      s.branch = e.branch;
      return s;

    case "status_changed":
      s.status = e.status;
      return s;

    case "control_changed":
      s.controller = e.controller;
      s.controllerName = e.controllerName;
      return s;

    case "prompt_queued":
      s.queuedPrompts = [...s.queuedPrompts, { promptId: e.promptId, deviceId: e.deviceId, text: e.text }];
      return s;

    case "prompt_submitted":
      // If this was sitting in the queue, it's no longer waiting — it's
      // starting now. Either way it enters `timeline` fresh, at the position
      // that reflects when it actually started (not when it was sent), so a
      // prompt and its turn are always adjacent regardless of how fast
      // follow-ups were typed.
      s.queuedPrompts = s.queuedPrompts.filter((q) => q.promptId !== e.promptId);
      s.timeline = [...s.timeline, { type: "prompt", promptId: e.promptId, deviceId: e.deviceId, text: e.text }];
      return s;

    case "assistant_delta":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => {
        const blocks = turn.blocks.slice();
        const existing = blocks[e.blockIndex];
        if (existing && existing.kind !== "tool_use") {
          blocks[e.blockIndex] = { ...existing, text: existing.text + e.text };
        } else if (!existing) {
          blocks[e.blockIndex] = {
            kind: e.blockKind === "thinking" ? "thinking" : "text",
            text: e.text,
            startedAtMs: e.ts,
            endedAtMs: null,
          };
          // The stream never tells us a block finished — only that the next one
          // started. Seeing blockIndex N begin means N-1 (if still open) just did.
          closePreviousBlock(blocks, e.blockIndex, e.ts);
        }
        return { ...turn, blocks };
      });
      return s;

    case "assistant_block":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => {
        const blocks = turn.blocks.slice();
        closePreviousBlock(blocks, e.blockIndex, e.ts);
        if (e.blockKind === "tool_use") {
          blocks[e.blockIndex] = {
            kind: "tool_use",
            toolUseId: e.toolUseId ?? "",
            toolName: e.toolName ?? "",
            toolInput: e.toolInput,
            result: null,
          };
        } else {
          // Canonical final text supersedes the streamed accumulation; keep
          // whatever startedAtMs the first delta recorded, or this event's own
          // timestamp if no delta ever arrived for this block.
          const existing = blocks[e.blockIndex];
          const startedAtMs = existing && existing.kind !== "tool_use" ? existing.startedAtMs : e.ts;
          blocks[e.blockIndex] = {
            kind: e.blockKind === "thinking" ? "thinking" : "text",
            text: e.text ?? "",
            startedAtMs,
            endedAtMs: e.ts,
          };
        }
        return { ...turn, blocks };
      });
      return s;

    case "tool_result":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        blocks: turn.blocks.map((b) =>
          b.kind === "tool_use" && b.toolUseId === e.toolUseId ? { ...b, result: { ok: e.ok, summary: e.summary } } : b,
        ),
      }));
      return s;

    case "permission_request":
      s.pending = [
        ...s.pending,
        { requestId: e.requestId, turnId: e.turnId, toolName: e.toolName, toolInput: e.toolInput },
      ];
      return s;

    case "permission_resolved":
      s.pending = s.pending.filter((p) => p.requestId !== e.requestId);
      return s;

    case "turn_result":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        promptId: e.promptId,
        status: e.ok ? "done" : "error",
        costUsd: e.costUsd,
        durationMs: e.durationMs,
        errorMessage: e.errorMessage,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
      }));
      // The rate-limit auto-retry (manager.submitPrompt) reruns a failed prompt as a
      // brand-new turn with the SAME promptId. Events are strictly ordered, so by the
      // time this retry's own turn_result lands, the attempt it replaced is guaranteed
      // to already be sitting in the timeline with status "error" — drop it so its
      // already-streamed (but superseded) answer doesn't render twice.
      s.timeline = s.timeline.filter(
        (it) => !(it.type === "turn" && it.turn.turnId !== e.turnId && it.turn.promptId === e.promptId && it.turn.status === "error"),
      );
      return s;

    case "notice":
      s.timeline = [...s.timeline, { type: "notice", text: e.text, level: e.level }];
      return s;

    case "error":
      // Non-turn errors aren't rendered inline in v1; surfaced via the client's
      // own error channel instead. Fold nothing.
      return s;

    default:
      return s;
  }
}

/** Fold many events (used for a replay batch). */
export function applyEvents(prev: ConversationState, events: SessionEvent[]): ConversationState {
  return events.reduce(applyEvent, prev);
}

/**
 * Immutably update the turn with `turnId`, creating it (appended to the
 * timeline) the first time we see its events — which, because the log is
 * ordered, is always right after its prompt.
 */
function updateTurn(
  timeline: TimelineItem[],
  turnId: string,
  fn: (turn: TurnView) => TurnView,
): TimelineItem[] {
  const idx = timeline.findIndex((it) => it.type === "turn" && it.turn.turnId === turnId);
  if (idx === -1) {
    return [...timeline, { type: "turn", turn: fn(emptyTurn(turnId)) }];
  }
  const next = timeline.slice();
  const item = next[idx] as Extract<TimelineItem, { type: "turn" }>;
  next[idx] = { type: "turn", turn: fn(item.turn) };
  return next;
}

/**
 * A block's own end is never signaled directly by the stream — only that the
 * next block started. Back-fill the previous block's endedAtMs from the new
 * block's timestamp if it's still open. No-op for tool_use (no duration shown)
 * or a block that already closed itself via its own assistant_block.
 */
function closePreviousBlock(blocks: BlockView[], newIndex: number, ts: number): void {
  const prev = blocks[newIndex - 1];
  if (prev && prev.kind !== "tool_use" && prev.endedAtMs == null) {
    blocks[newIndex - 1] = { ...prev, endedAtMs: ts };
  }
}

function emptyTurn(turnId: string): TurnView {
  return {
    turnId,
    promptId: null,
    blocks: [],
    status: "running",
    costUsd: null,
    durationMs: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
  };
}
