import type { AgentUsage, Attachment, AttachmentView, SessionComposer, SessionEvent, SessionStatus } from "@renki/protocol";

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
      /** `images`: what the tool showed Claude — a screenshot, an image it Read. */
      result: { ok: boolean; summary: string; images?: AttachmentView[] } | null;
      /** Present only for a Task call once its subagent starts forwarding activity. */
      subagent?: SubagentView;
      /**
       * Present once a background Agent-tool task (run_in_background: true)
       * reports its outcome — arrives independently of `result` (which, for
       * this kind of call, is just the SDK's immediate "launched" ack) and
       * often long after this block's own turn has finished.
       */
      backgroundTask?: { status: "completed" | "failed" | "stopped"; summary: string };
      /** When Claude made the call — the daemon's clock, from the event. */
      startedAtMs?: number;
      /** For an Agent/Task call: what the agent has spent, live while it runs and final once it reports. */
      agentUsage?: AgentUsage;
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
  /** Context re-read from the prompt cache — counted apart from inputTokens; see the event's own doc. */
  cachedInputTokens: number | null;
  /** True when `status === "error"` because the controller stopped the turn, not a real failure. */
  interrupted: boolean;
};

/** A prompt the controller sent, an assistant turn, a system notice, or a model switch. */
export type TimelineItem =
  | { type: "prompt"; promptId: string; deviceId: string; text: string; attachments?: Attachment[] }
  | { type: "turn"; turn: TurnView }
  | { type: "notice"; text: string; level: "info" | "warn" }
  /**
   * Background tasks that finished without a tool call in the timeline to
   * attach to (the call that started them was never replayed). Consecutive
   * ones share one item, so a long unattended run shows one collapsible row
   * rather than a wall of them.
   */
  | { type: "background_tasks"; tasks: { summary: string; status: "completed" | "failed" | "stopped" }[] }
  /** null on either side means the SDK's own default model. */
  | { type: "model_change"; model: string | null; previousModel: string | null };

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
  /**
   * The model the session's turns are running under, as the LOG reports it —
   * null for the SDK's default or before any turn has run. Distinct from the
   * composer's picker, which is per-device and about the NEXT prompt.
   */
  model: string | null;
  /**
   * The model / thinking effort / permission mode pinned to this SESSION, as
   * last pushed by the daemon. Null until that first push arrives (the daemon
   * sends one on subscribe, so that's immediately in practice).
   *
   * Deliberately not folded from the event log like everything else here: the
   * composer is session *settings*, not conversation history, and replaying a
   * transcript shouldn't rewind which model the picker is set to. It rides the
   * roster `session` push instead, which is also what makes a change on one
   * device show up on another without a refresh.
   */
  composer: SessionComposer | null;
  /** Highest seq folded in — sent as lastSeq on (re)subscribe. */
  lastSeq: number;
};

/**
 * A turn's `blocks` is indexed by Claude's own block numbers and can have
 * gaps. JSON has no gaps: saving a conversation writes each one as `null`,
 * and code that walks blocks expected a gap (skipped) not a null (read). Put
 * the gaps back on anything restored from storage.
 */
export function restoreBlockGaps(state: ConversationState): ConversationState {
  const fix = (blocks: (BlockView | null)[]): BlockView[] => {
    const out: BlockView[] = [];
    blocks.forEach((b, i) => {
      if (b == null) return;
      out[i] = b.kind === "tool_use" && b.subagent ? { ...b, subagent: { ...b.subagent, blocks: fix(b.subagent.blocks) } } : b;
    });
    return out;
  };
  return {
    ...state,
    timeline: state.timeline.map((it) => (it.type === "turn" ? { ...it, turn: { ...it.turn, blocks: fix(it.turn.blocks) } } : it)),
  };
}

/**
 * Version of the folded ConversationState shape and folding rules. A client
 * that caches folded conversations (see RealtimeClient's ConversationCache)
 * keys the cache by this, so bump it whenever applyEvent changes what it
 * produces — otherwise a cached copy would keep the old folding forever.
 */
// 2: copies cached by v1 could hold a gap — a catch-up that failed to fold
// was skipped while later live events still applied — so they're dropped.
// 3: tool results carry their images; older copies folded them away.
// 4: tool calls carry their start time and agents their usage (the agent map).
export const CONVERSATION_CACHE_VERSION = 4;

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
    model: null,
    composer: null,
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
      s.timeline = updateTurn(s.timeline, subagentTurnId(s.timeline, e.turnId, e.parentToolUseId), (turn) => ({
        ...turn,
        blocks: e.parentToolUseId
          ? updateSubagentBlocks(turn.blocks, e.parentToolUseId, (sub) => applyDelta(sub, e.blockIndex, e.blockKind, e.text, e.ts))
          : applyDelta(turn.blocks, e.blockIndex, e.blockKind, e.text, e.ts),
      }));
      return s;

    case "assistant_block":
      s.timeline = updateTurn(s.timeline, subagentTurnId(s.timeline, e.turnId, e.parentToolUseId), (turn) => ({
        ...turn,
        blocks: e.parentToolUseId
          ? updateSubagentBlocks(
              turn.blocks,
              e.parentToolUseId,
              (sub) => applyBlock(sub, subagentSlot(sub, e.blockIndex, e.blockKind, e.toolUseId), e.blockKind, e.text, e.toolUseId, e.toolName, e.toolInput, e.durationMs, e.ts),
              { subagentType: e.subagentType ?? null, taskDescription: e.taskDescription ?? null },
            )
          : applyBlock(turn.blocks, e.blockIndex, e.blockKind, e.text, e.toolUseId, e.toolName, e.toolInput, e.durationMs, e.ts),
      }));
      return s;

    case "tool_result":
      s.timeline = updateTurn(s.timeline, subagentTurnId(s.timeline, e.turnId, e.toolUseId), (turn) => ({
        ...turn,
        blocks: applyToolResult(
          turn.blocks,
          e.toolUseId,
          { ok: e.ok, summary: e.summary, ...(e.images?.length ? { images: e.images } : {}) },
          e.agentUsage,
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
      // Also the fallback source of `model` for a transcript recorded before
      // model_changed existed, where the turn's own result is the only place
      // the model was ever written down.
      if (e.model !== undefined) s.model = e.model;
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => ({
        ...turn,
        promptId: e.promptId,
        status: e.ok ? "done" : "error",
        costUsd: e.costUsd,
        durationMs: e.durationMs,
        errorMessage: e.errorMessage,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cachedInputTokens: e.cachedInputTokens ?? null,
        interrupted: e.interrupted ?? false,
      }));
      // The rate-limit auto-retry (manager.submitPrompt) reruns a failed prompt as a
      // brand-new turn with the SAME promptId. Events are strictly ordered, so by the
      // time this retry's own turn_result lands, the attempt it replaced is guaranteed
      // to already be sitting in the timeline with status "error" — drop it so its
      // already-streamed (but superseded) answer doesn't render twice.
      //
      // Only when it never got as far as a tool call, though. An attempt that
      // ran tools before hitting the limit isn't superseded — its edits, commits
      // and background agents happened, and the retry carries on from them.
      // Dropping one of those erased hours of work from view, and orphaned the
      // agents it started.
      s.timeline = s.timeline.filter(
        (it) =>
          !(
            it.type === "turn" &&
            it.turn.turnId !== e.turnId &&
            it.turn.promptId === e.promptId &&
            it.turn.status === "error" &&
            !it.turn.blocks.some((b) => b?.kind === "tool_use")
          ),
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

    case "model_changed":
      s.timeline = [...s.timeline, { type: "model_change", model: e.model, previousModel: e.previousModel }];
      // What the session is running NOW — a client can offer this as the
      // composer's model on a device that has never opened this session.
      s.model = e.model;
      return s;

    case "background_task": {
      const done = { status: e.status, summary: e.summary };
      const found = e.toolUseId
        ? patchToolBlock(s.timeline, e.toolUseId, (b) => ({ ...b, backgroundTask: done, ...(e.usage ? { agentUsage: e.usage } : {}) }))
        : null;
      if (found) {
        s.timeline = found;
        return s;
      }
      const task = { summary: e.summary, status: e.status };
      const last = s.timeline[s.timeline.length - 1];
      s.timeline =
        last?.type === "background_tasks"
          ? [...s.timeline.slice(0, -1), { type: "background_tasks", tasks: [...last.tasks, task] }]
          : [...s.timeline, { type: "background_tasks", tasks: [task] }];
      return s;
    }

    case "agent_progress": {
      // Never let a late progress report wind back what the agent's own
      // result already said it spent in all.
      const found = patchToolBlock(s.timeline, e.toolUseId, (b) =>
        b.agentUsage && b.agentUsage.tokens >= e.usage.tokens ? b : { ...b, agentUsage: e.usage },
      );
      if (found) s.timeline = found;
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
/**
 * The turn an event about `toolUseId` belongs in: its own `turnId` when that
 * turn holds the call, otherwise whichever turn does.
 *
 * A background agent outlives the turn that started it. Its steps (and the
 * results of the commands it runs) can arrive stamped with a later turn — the
 * daemon's record of which turn owns an agent is in memory, and gone after
 * the live process is recycled. Routed by turnId alone, those steps found no
 * parent in the later turn and were dropped, and every background command the
 * agent ran then surfaced as a loose "finished" row at the bottom.
 */
function subagentTurnId(timeline: TimelineItem[], turnId: string, toolUseId: string | null | undefined): string {
  if (!toolUseId) return turnId;
  const own = timeline.find((it) => it.type === "turn" && it.turn.turnId === turnId);
  if (own?.type === "turn" && containsToolUse(own.turn.blocks, toolUseId)) return turnId;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i]!;
    if (it.type === "turn" && containsToolUse(it.turn.blocks, toolUseId)) return it.turn.turnId;
  }
  return turnId;
}

/**
 * Where a subagent's block goes. Normally its own index — but older daemons
 * numbered every whole (non-streamed) subagent message from 0, so each step
 * landed on the last one's slot and replaced it. A block can only legitimately
 * update a slot holding the same kind of block (and, for a tool call, the
 * same call), so anything else is a new step: append it.
 */
function subagentSlot(blocks: BlockView[], index: number, kind: string, toolUseId: string | null): number {
  const existing = blocks[index];
  if (!existing) return index;
  const sameKind = existing.kind === (kind === "thinking" ? "thinking" : kind === "tool_use" ? "tool_use" : "text");
  const sameCall = existing.kind !== "tool_use" || existing.toolUseId === toolUseId;
  return sameKind && sameCall ? index : blocks.length;
}

/** Is a tool_use with this id anywhere in these blocks, subagents included? */
function containsToolUse(blocks: BlockView[], toolUseId: string): boolean {
  for (const b of blocks) {
    if (b?.kind !== "tool_use") continue;
    if (b.toolUseId === toolUseId) return true;
    if (b.subagent && containsToolUse(b.subagent.blocks, toolUseId)) return true;
  }
  return false;
}

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
    next[blockIndex] = { kind: "tool_use", toolUseId: toolUseId ?? "", toolName: toolName ?? "", toolInput, result: null, startedAtMs: ts };
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
    if (b?.kind !== "tool_use") return b;
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
type ToolUseBlock = Extract<BlockView, { kind: "tool_use" }>;
type ToolResultView = NonNullable<Extract<BlockView, { kind: "tool_use" }>["result"]>;

function applyToolResult(blocks: BlockView[], toolUseId: string, result: ToolResultView, agentUsage?: AgentUsage): BlockView[] {
  return blocks.map((b) => {
    if (b?.kind !== "tool_use") return b;
    if (b.toolUseId === toolUseId) {
      return { ...b, result, ...(agentUsage ? { agentUsage } : {}), subagent: b.subagent ? { ...b.subagent, status: "done" as const } : b.subagent };
    }
    if (b.subagent) {
      return { ...b, subagent: { ...b.subagent, blocks: applyToolResult(b.subagent.blocks, toolUseId, result, agentUsage) } };
    }
    return b;
  });
}

/**
 * Update a tool_use block by toolUseId — a background_task outcome, an
 * agent's progress — searching EVERY turn in the timeline (not just one,
 * unlike applyToolResult): a background agent can report back during a turn
 * other than the one that spawned it, so which turn holds the block isn't
 * known in advance. Returns null if no block anywhere matches, e.g. the
 * spawning turn's blocks were never replayed (a background_task then falls
 * back to a plain notice).
 */
function patchToolBlock(timeline: TimelineItem[], toolUseId: string, fn: (b: ToolUseBlock) => ToolUseBlock): TimelineItem[] | null {
  let found = false;
  function patch(blocks: BlockView[]): BlockView[] {
    return blocks.map((b) => {
      if (b?.kind !== "tool_use") return b;
      if (b.toolUseId === toolUseId) {
        found = true;
        return fn(b);
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
    cachedInputTokens: null,
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
