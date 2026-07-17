import { z } from "zod";
import { DeviceId, PermissionDecision, SessionStatus } from "./domain.js";

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
  /** Session was created against a repo/branch and given a worktree. */
  z.object({
    kind: z.literal("session_created"),
    repoId: z.string(),
    repoName: z.string(),
    baseBranch: z.string(),
    branch: z.string(),
    worktreePath: z.string(),
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
  }),

  /** A streamed token/chunk of an assistant turn. Concatenate deltas per (turnId, blockIndex). */
  z.object({
    kind: z.literal("assistant_delta"),
    turnId: z.string(),
    blockIndex: z.number().int().nonnegative(),
    blockKind: AssistantBlockKind,
    text: z.string(),
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
  }),

  /** A non-turn error (spawn failure, worktree problem, etc.). */
  z.object({
    kind: z.literal("error"),
    message: z.string(),
    code: z.string().nullable(),
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
