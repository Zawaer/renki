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
  | { kind: "text" | "thinking"; text: string }
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
};

/** A prompt the controller sent, or an assistant turn in response. */
export type TimelineItem =
  | { type: "prompt"; promptId: string; deviceId: string; text: string }
  | { type: "turn"; turn: TurnView };

export type PermissionView = {
  requestId: string;
  turnId: string;
  toolName: string;
  toolInput: unknown;
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
    lastSeq: -1,
  };
}

/** Fold one event into state, returning a NEW state object (never mutates prev). */
export function applyEvent(prev: ConversationState, e: SessionEvent): ConversationState {
  const s: ConversationState = { ...prev, lastSeq: Math.max(prev.lastSeq, e.seq) };

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

    case "prompt_submitted":
      s.timeline = [...s.timeline, { type: "prompt", promptId: e.promptId, deviceId: e.deviceId, text: e.text }];
      return s;

    case "assistant_delta":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => {
        const blocks = turn.blocks.slice();
        const existing = blocks[e.blockIndex];
        if (existing && existing.kind !== "tool_use") {
          blocks[e.blockIndex] = { kind: existing.kind, text: existing.text + e.text };
        } else if (!existing) {
          blocks[e.blockIndex] = { kind: e.blockKind === "thinking" ? "thinking" : "text", text: e.text };
        }
        return { ...turn, blocks };
      });
      return s;

    case "assistant_block":
      s.timeline = updateTurn(s.timeline, e.turnId, (turn) => {
        const blocks = turn.blocks.slice();
        if (e.blockKind === "tool_use") {
          blocks[e.blockIndex] = {
            kind: "tool_use",
            toolUseId: e.toolUseId ?? "",
            toolName: e.toolName ?? "",
            toolInput: e.toolInput,
            result: null,
          };
        } else {
          // Canonical final text supersedes the streamed accumulation.
          blocks[e.blockIndex] = { kind: e.blockKind === "thinking" ? "thinking" : "text", text: e.text ?? "" };
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
      }));
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

function emptyTurn(turnId: string): TurnView {
  return {
    turnId,
    promptId: null,
    blocks: [],
    status: "running",
    costUsd: null,
    durationMs: null,
    errorMessage: null,
  };
}
