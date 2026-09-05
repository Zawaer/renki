import { z } from "zod";
import { Attachment } from "./attachments.js";
import { DeviceId, MergeConflictMeta, PermissionDecision, SessionPurpose, SessionStatus } from "./domain.js";

/**
 * THE EVENT LOG — this is the mechanism that makes staleness structurally
 * impossible instead of something we patch over.
 *
 * Every meaningful thing that happens to a session becomes an immutable event:
 * a prompt was sent, a token of Claude's response arrived, a tool wants to run,
 * a permission was granted, control changed hands. The daemon appends each event
 * to a per-session log and stamps it with a monotonically increasing `seq`.
 *
 * A client never asks "what is the current state?" — it asks "give me every
 * event after seq N", replays them to rebuild state, then streams live. Because
 * the log is the single source of truth, a reconnecting client can NEVER miss an
 * update: whatever happened while it was gone is still sitting in the log waiting.
 *
 * Two schemas on purpose:
 *   EventPayload  — what the daemon emits (no seq yet; it doesn't know it).
 *   SessionEvent  — what gets stored & sent on the wire (payload + envelope).
 */

/** Content-block kinds inside an assistant turn, kept coarse for v1. */
export const AssistantBlockKind = z.enum(["text", "thinking", "tool_use"]);
export type AssistantBlockKind = z.infer<typeof AssistantBlockKind>;

const payloads = [
  /**
   * Session was created, either against a repo/branch (with a worktree) or,
   * if `repoId` is null, as a plain scratch directory with no git involved.
   */
  z.object({
    kind: z.literal("session_created"),
    repoId: z.string().nullable(),
    repoName: z.string(),
    baseBranch: z.string().nullable(),
    branch: z.string().nullable(),
    worktreePath: z.string(),
    purpose: SessionPurpose.optional(),
    mergeMeta: MergeConflictMeta.nullable().optional(),
  }),

  /** Lifecycle transition (idle/busy/error/archived). */
  z.object({
    kind: z.literal("status_changed"),
    status: SessionStatus,
  }),

  /**
   * The take-control lock changed. `controller` is null when released.
   * Every viewer sees this live, so the UI can immediately show who's driving.
   */
  z.object({
    kind: z.literal("control_changed"),
    controller: DeviceId.nullable(),
    controllerName: z.string().nullable(),
  }),

  /** A finished prompt was submitted by the controller (not keystrokes — the whole thing). */
  z.object({
    kind: z.literal("prompt_submitted"),
    promptId: z.string(),
    deviceId: DeviceId,
    text: z.string(),
    attachments: z.array(Attachment).optional(),
    /**
     * True when this prompt was delivered INTO a turn that was already running
     * (the controller typed while Claude was working). The CLI picks it up at
     * its next tool-call boundary and answers it within that same turn, so no
     * separate turn/turn_result exists for it — the running turn's turn_result
     * lists it in `promptIds`. Absent/false for an ordinary prompt that starts
     * its own turn.
     */
    steered: z.boolean().optional(),
  }),

  /**
   * A turn began. Emitted by the daemon the moment it knows the turnId — for a
   * prompted turn right after `prompt_submitted`, and for a turn the CLI starts
   * on its own (e.g. the main agent reacting to a background agent finishing)
   * as the only heads-up clients get before its blocks stream in. `trigger`
   * is what clients label the turn by. Optional in the log's history: turns
   * recorded before this event existed are still created lazily from their
   * first block.
   */
  z.object({
    kind: z.literal("turn_started"),
    turnId: z.string(),
    promptId: z.string(),
    trigger: z.enum(["prompt", "background_task", "auto"]),
  }),

  /**
   * The controller submitted a prompt while the session was busy. It's held
   * daemon-side and will become a `prompt_submitted` turn automatically the
   * instant the current turn finishes — no separate "queued" session status,
   * this is just a visible record of what's waiting.
   */
  z.object({
    kind: z.literal("prompt_queued"),
    promptId: z.string(),
    deviceId: DeviceId,
    text: z.string(),
  }),

  /** A streamed token/chunk of an assistant turn. Concatenate deltas per (turnId, blockIndex). */
  z.object({
    kind: z.literal("assistant_delta"),
    turnId: z.string(),
    blockIndex: z.number().int().nonnegative(),
    blockKind: AssistantBlockKind,
    text: z.string(),
    /**
     * Present only when this delta is a subagent's own forwarded text (the
     * Agent SDK's `forwardSubagentText` option) — the tool_use id of the Task
     * call that spawned it. Absent means it belongs to the turn's own
     * top-level blocks, same as before subagent forwarding existed.
     */
    parentToolUseId: z.string().optional(),
  }),

  /** A completed assistant content block (final text of a block, or a tool_use call). */
  z.object({
    kind: z.literal("assistant_block"),
    turnId: z.string(),
    blockIndex: z.number().int().nonnegative(),
    blockKind: AssistantBlockKind,
    text: z.string().nullable(),
    toolUseId: z.string().nullable(),
    toolName: z.string().nullable(),
    toolInput: z.unknown().nullable(),
    /**
     * How long this block took to produce, in ms — measured by the daemon from
     * the block's first streamed delta to its completion. Carried on the block
     * because the deltas themselves are compacted away once it lands
     * (EventLog.compactBlock), so a replayed session has no other way to know
     * how long Claude spent thinking. Absent for blocks that never streamed.
     */
    durationMs: z.number().int().nonnegative().nullable().optional(),
    /** See assistant_delta's own doc — same meaning here. */
    parentToolUseId: z.string().optional(),
    /** Which subagent type produced this (e.g. "Explore") — only set alongside parentToolUseId. */
    subagentType: z.string().optional(),
    /** The task description the subagent was given — only set alongside parentToolUseId. */
    taskDescription: z.string().optional(),
  }),

  /** Result of a tool the SDK executed on Claude's behalf. */
  z.object({
    kind: z.literal("tool_result"),
    turnId: z.string(),
    toolUseId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),

  /**
   * Claude is asking to use a tool that isn't pre-approved. Visible to ALL
   * viewers live, but only the current controller may resolve it.
   */
  z.object({
    kind: z.literal("permission_request"),
    requestId: z.string(),
    turnId: z.string(),
    toolName: z.string(),
    toolInput: z.unknown(),
  }),

  /** A permission request was answered (by the controller or auto-timeout). */
  z.object({
    kind: z.literal("permission_resolved"),
    requestId: z.string(),
    decision: PermissionDecision,
    byDeviceId: DeviceId.nullable(),
  }),

  /** A turn finished. Carries cost/usage so clients can show it and we can budget. */
  z.object({
    kind: z.literal("turn_result"),
    turnId: z.string(),
    promptId: z.string(),
    ok: z.boolean(),
    costUsd: z.number().nullable(),
    durationMs: z.number().int().nullable(),
    errorMessage: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    /** True when this failure is the controller stopping the turn (the "stop" button), not a real error. */
    interrupted: z.boolean().optional(),
    /** The per-turn model override the client sent, or null when it ran the SDK's own default. Optional so events stored before this field existed still parse. */
    model: z.string().nullable().optional(),
    /** Which kind of client submitted the prompt this turn answers ("web"/"phone"/"vscode"), derived from the submitting device's id. Optional for the same reason as `model`. */
    clientType: z.string().nullable().optional(),
    /**
     * Every prompt this turn answered: `promptId` first, then any prompts
     * steered into it mid-turn (see prompt_submitted.steered), in delivery
     * order. Absent on events recorded before steering existed (then it's just
     * `[promptId]`).
     */
    promptIds: z.array(z.string()).optional(),
  }),

  /** A non-turn error (spawn failure, worktree problem, etc.). */
  z.object({
    kind: z.literal("error"),
    message: z.string(),
    code: z.string().nullable(),
  }),

  /**
   * A system notice rendered inline in the conversation — e.g. "rate limit hit,
   * switched to account 2 and retried". Informational; not tied to a turn.
   */
  z.object({
    kind: z.literal("notice"),
    text: z.string(),
    level: z.enum(["info", "warn"]),
  }),

  /**
   * How full this session's context window is, as the CLI itself reports it
   * (Query.getContextUsage). Read after a turn settles rather than polled:
   * it only changes when the conversation grows. `maxTokens` is the usable
   * budget for the session's model, so the ratio is what the user cares about.
   */
  z.object({
    kind: z.literal("context_usage"),
    usedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
    /** 0-100, as the CLI computes it (it accounts for its own auto-compact headroom). */
    percentage: z.number(),
    /** True when the CLI will auto-compact this conversation as it fills up. */
    autoCompact: z.boolean().optional(),
  }),

  /**
   * A background Agent-tool task (`run_in_background: true`, or one resumed
   * later via SendMessage) reporting its outcome. Deliberately NOT tied to a
   * turnId like tool_result is: the task can be spawned in one turn and report
   * back during a completely different, later turn (or after the spawning
   * turn has already finished), so the client matches it to the Task tool_use
   * block purely by toolUseId, wherever in the timeline that block lives.
   */
  z.object({
    kind: z.literal("background_task"),
    taskId: z.string(),
    /** The Task tool_use id that spawned it, or null if the SDK didn't supply one. */
    toolUseId: z.string().nullable(),
    status: z.enum(["completed", "failed", "stopped"]),
    summary: z.string(),
  }),
] as const;

/** What the daemon produces before it knows the sequence number. */
export const EventPayload = z.discriminatedUnion("kind", payloads);
export type EventPayload = z.infer<typeof EventPayload>;

/** The envelope stamped onto every stored/broadcast event. */
export const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  ts: z.number().int(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** The stored, replayable, wire-ready event: envelope + payload. */
export const SessionEvent = z.intersection(EventEnvelope, EventPayload);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Convenience: the `kind` string literal union. */
export type EventKind = EventPayload["kind"];
