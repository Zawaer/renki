import type { Attachment, SessionEvent, SessionStatus } from "@crc/protocol";

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

/**
 * A subagent's own nested activity (Agent SDK's `forwardSubagentText`) —
 * attached to the `Task` tool_use block that spawned it. `status` flips to
 * "done" the moment that same tool_use's own `tool_result` arrives (the
 * subagent has nothing else to say once its Task call has returned).
 */
export type SubagentView = {
  subagentType: string | null;
  taskDescription: string | null;
  blocks: BlockView[];
  status: "running" | "done";
};

export type BlockView =
  | { kind: "text" | "thinking"; text: string; startedAtMs: number | null; endedAtMs: number | null }
  | {
      kind: "tool_use";
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      result: { ok: boolean; summary: string } | null;
      /** Present only for a Task call once its subagent starts forwarding activity. */
      subagent?: SubagentView;
      /**
       * Present once a background Agent-tool task (run_in_background: true)
       * reports its outcome — arrives independently of `result` (which, for
       * this kind of call, is just the SDK's immediate "launched" ack) and
       * often long after this block's own turn has finished.
       */
      backgroundTask?: { status: "completed" | "failed" | "stopped"; summary: string };
    };

/** A prompt the controller sent while this turn was already running — answered inside the turn, not by a turn of its own. */
export type SteeredPromptView = {
  promptId: string;
  deviceId: string;
  text: string;
  attachments?: Attachment[];
  /** Index of the last block that existed when it arrived (-1 = before any) — render it right after that block. */
  afterBlockIndex: number;
};

export type TurnView = {
  turnId: string;
  promptId: string | null;
  /**
   * What started the turn: a controller prompt, the main agent reacting to a
   * background agent finishing, or the CLI continuing for some other reason.
   * null for turns recorded before turn_started existed.
   */
  trigger: "prompt" | "background_task" | "auto" | null;
  steeredPrompts: SteeredPromptView[];
  /** Ordered by the block index Claude assigned. */
  blocks: BlockView[];
  status: "running" | "done" | "error";
  costUsd: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  /** Real usage from the SDK's result message — only known once the turn finishes. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when `status === "error"` because the controller stopped the turn, not a real failure. */
  interrupted: boolean;
};

/** A prompt the controller sent, an assistant turn, or a system notice. */
export type TimelineItem =
  | { type: "prompt"; promptId: string; deviceId: string; text: string; attachments?: Attachment[] }
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

/** How full the session's context window is, as the CLI last reported it. */
export type ContextUsageView = {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  autoCompact: boolean;
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
  /** null until the daemon has reported it for this session (after its first turn). */
  context: ContextUsageView | null;
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
    context: null,
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

    case "turn_started":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        promptId: turn.promptId ?? e.promptId,
        trigger: e.trigger,
      }));
      return s;

    case "prompt_submitted": {
      s.queuedPrompts = s.queuedPrompts.filter((q) => q.promptId !== e.promptId);
      // Steered into a running turn: it belongs INSIDE that turn, pinned after
      // whatever block was current when it landed, so the transcript reads in
      // the order things actually happened (Claude's answer follows it).
      if (e.steered) {
        let idx = -1;
        for (let i = s.timeline.length - 1; i >= 0; i--) {
          const it = s.timeline[i]!;
          if (it.type === "turn" && it.turn.status === "running") {
            idx = i;
            break;
          }
        }
        if (idx !== -1) {
          const item = s.timeline[idx] as Extract<TimelineItem, { type: "turn" }>;
          const steered: SteeredPromptView = {
            promptId: e.promptId,
            deviceId: e.deviceId,
            text: e.text,
            attachments: e.attachments,
            afterBlockIndex: item.turn.blocks.length - 1,
          };
          const next = s.timeline.slice();
          next[idx] = { type: "turn", turn: { ...item.turn, steeredPrompts: [...item.turn.steeredPrompts, steered] } };
          s.timeline = next;
          return s;
        }
      }
      // If this was sitting in the queue, it's no longer waiting — it's
      // starting now. Either way it enters `timeline` fresh, at the position
      // that reflects when it actually started (not when it was sent), so a
      // prompt and its turn are always adjacent regardless of how fast
      // follow-ups were typed.
      s.timeline = [
        ...s.timeline,
        { type: "prompt", promptId: e.promptId, deviceId: e.deviceId, text: e.text, attachments: e.attachments },
      ];
      return s;
    }

    case "assistant_delta":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        blocks: e.parentToolUseId
          ? updateSubagentBlocks(turn.blocks, e.parentToolUseId, (sub) => applyDelta(sub, e.blockIndex, e.blockKind, e.text, e.ts))
          : applyDelta(turn.blocks, e.blockIndex, e.blockKind, e.text, e.ts),
      }));
      return s;

    case "assistant_block":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        blocks: e.parentToolUseId
          ? updateSubagentBlocks(
              turn.blocks,
              e.parentToolUseId,
              (sub) => applyBlock(sub, e.blockIndex, e.blockKind, e.text, e.toolUseId, e.toolName, e.toolInput, e.durationMs, e.ts),
              { subagentType: e.subagentType ?? null, taskDescription: e.taskDescription ?? null },
            )
          : applyBlock(turn.blocks, e.blockIndex, e.blockKind, e.text, e.toolUseId, e.toolName, e.toolInput, e.durationMs, e.ts),
      }));
      return s;

    case "tool_result":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        blocks: applyToolResult(turn.blocks, e.toolUseId, e.ok, e.summary),
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
        interrupted: e.interrupted ?? false,
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

    case "context_usage":
      s.context = {
        usedTokens: e.usedTokens,
        maxTokens: e.maxTokens,
        percentage: e.percentage,
        autoCompact: e.autoCompact ?? false,
      };
      return s;

    case "notice":
      s.timeline = [...s.timeline, { type: "notice", text: e.text, level: e.level }];
      return s;

    case "background_task": {
      const found = e.toolUseId ? applyBackgroundTask(s.timeline, e.toolUseId, e.status, e.summary) : null;
      s.timeline = found
        ? found
        : [
            ...s.timeline,
            {
              type: "notice",
              text: `Background task finished: ${e.summary}`,
              level: e.status === "completed" ? "info" : "warn",
            },
          ];
      return s;
    }

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

/** Fold one assistant_delta into a plain block list — shared by the main turn's own blocks and a subagent's nested ones. */
function applyDelta(
  blocks: BlockView[],
  blockIndex: number,
  blockKind: "text" | "thinking" | "tool_use",
  text: string,
  ts: number,
): BlockView[] {
  const next = blocks.slice();
  const existing = next[blockIndex];
  if (existing && existing.kind !== "tool_use") {
    next[blockIndex] = { ...existing, text: existing.text + text };
  } else if (!existing) {
    next[blockIndex] = { kind: blockKind === "thinking" ? "thinking" : "text", text, startedAtMs: ts, endedAtMs: null };
    // The stream never tells us a block finished — only that the next one
    // started. Seeing blockIndex N begin means N-1 (if still open) just did.
    closePreviousBlock(next, blockIndex, ts);
  }
  return next;
}

/** Fold one assistant_block into a plain block list — shared by the main turn's own blocks and a subagent's nested ones. */
function applyBlock(
  blocks: BlockView[],
  blockIndex: number,
  blockKind: "text" | "thinking" | "tool_use",
  text: string | null,
  toolUseId: string | null,
  toolName: string | null,
  toolInput: unknown,
  durationMs: number | null | undefined,
  ts: number,
): BlockView[] {
  const next = blocks.slice();
  closePreviousBlock(next, blockIndex, ts);
  if (blockKind === "tool_use") {
    next[blockIndex] = { kind: "tool_use", toolUseId: toolUseId ?? "", toolName: toolName ?? "", toolInput, result: null };
  } else {
    // Canonical final text supersedes the streamed accumulation. Timing comes
    // from the daemon's own measurement when it sent one — the only source
    // that survives a replay, since the deltas it was measured from are
    // compacted away — else from whatever the first delta recorded live.
    const existing = next[blockIndex];
    const startedAtMs =
      durationMs != null ? ts - durationMs : existing && existing.kind !== "tool_use" ? existing.startedAtMs : ts;
    next[blockIndex] = { kind: blockKind === "thinking" ? "thinking" : "text", text: text ?? "", startedAtMs, endedAtMs: ts };
  }
  return next;
}

/**
 * Route an assistant_delta/assistant_block tagged with a subagent's
 * parentToolUseId into that Task tool_use block's own nested `subagent.blocks`
 * instead of the turn's top-level ones. Searches recursively (a subagent
 * that itself spawns a subagent nests two deep) since the Task tool_use block
 * in question might not be at this level — it's guaranteed to already exist
 * SOMEWHERE in the tree by the time any of its subagent's messages arrive
 * (the model can't invoke a tool before finishing the message that calls it).
 */
function updateSubagentBlocks(
  blocks: BlockView[],
  parentToolUseId: string,
  fn: (subBlocks: BlockView[]) => BlockView[],
  meta?: { subagentType: string | null; taskDescription: string | null },
): BlockView[] {
  return blocks.map((b) => {
    if (b.kind !== "tool_use") return b;
    if (b.toolUseId === parentToolUseId) {
      const prev = b.subagent ?? { subagentType: null, taskDescription: null, blocks: [], status: "running" as const };
      return {
        ...b,
        subagent: {
          subagentType: meta?.subagentType ?? prev.subagentType,
          taskDescription: meta?.taskDescription ?? prev.taskDescription,
          blocks: fn(prev.blocks),
          status: "running",
        },
      };
    }
    if (b.subagent) {
      return { ...b, subagent: { ...b.subagent, blocks: updateSubagentBlocks(b.subagent.blocks, parentToolUseId, fn, meta) } };
    }
    return b;
  });
}

/**
 * Apply a tool_result by toolUseId, searching both the turn's top-level
 * blocks and every subagent's nested ones — toolUseIds are unique regardless
 * of nesting, so at most one block anywhere matches. Marks the matching
 * Task's own subagent "done" too: its tool_result arriving means the
 * subagent has nothing left to forward.
 */
function applyToolResult(blocks: BlockView[], toolUseId: string, ok: boolean, summary: string): BlockView[] {
  return blocks.map((b) => {
    if (b.kind !== "tool_use") return b;
    if (b.toolUseId === toolUseId) {
      return { ...b, result: { ok, summary }, subagent: b.subagent ? { ...b.subagent, status: "done" as const } : b.subagent };
    }
    if (b.subagent) {
      return { ...b, subagent: { ...b.subagent, blocks: applyToolResult(b.subagent.blocks, toolUseId, ok, summary) } };
    }
    return b;
  });
}

/**
 * Attach a background_task outcome to its Task tool_use block by toolUseId,
 * searching EVERY turn in the timeline (not just one, unlike applyToolResult)
 * — a background task can report back during a turn other than the one that
 * spawned it, so which turn currently holds the matching block isn't known in
 * advance. Returns null (caller falls back to a plain notice) if no block
 * anywhere matches, e.g. the spawning turn's blocks were never replayed.
 */
function applyBackgroundTask(
  timeline: TimelineItem[],
  toolUseId: string,
  status: "completed" | "failed" | "stopped",
  summary: string,
): TimelineItem[] | null {
  let found = false;
  function patch(blocks: BlockView[]): BlockView[] {
    return blocks.map((b) => {
      if (b.kind !== "tool_use") return b;
      if (b.toolUseId === toolUseId) {
        found = true;
        return { ...b, backgroundTask: { status, summary } };
      }
      if (b.subagent) return { ...b, subagent: { ...b.subagent, blocks: patch(b.subagent.blocks) } };
      return b;
    });
  }
  const next = timeline.map((item) =>
    item.type === "turn" ? { type: "turn" as const, turn: { ...item.turn, blocks: patch(item.turn.blocks) } } : item,
  );
  return found ? next : null;
}

function emptyTurn(turnId: string): TurnView {
  return {
    turnId,
    promptId: null,
    trigger: null,
    steeredPrompts: [],
    blocks: [],
    status: "running",
    costUsd: null,
    durationMs: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    interrupted: false,
  };
}

/**
 * Human label for a turn nobody prompted (see turn_started.trigger), or null
 * for an ordinary prompted turn. Shared by every client so the wording matches.
 */
export function turnTriggerLabel(turn: TurnView): string | null {
  if (turn.trigger === "background_task") return "Background agent finished — Claude's follow-up";
  if (turn.trigger === "auto") return "Claude continued on its own";
  return null;
}
