import { z } from "zod";
import { Attachment, MAX_ATTACHMENTS_PER_PROMPT } from "./attachments.js";
import { PermissionDecision, Session } from "./domain.js";
import { SessionEvent } from "./events.js";

/**
 * WebSocket protocol. Consumed by the daemon's WS server (Step 2) and every
 * client. Auth + device identity are handled at the connection layer (a bearer
 * token + deviceId supplied on the upgrade request / query string), so the
 * message schemas below assume an already-authenticated, identified socket.
 *
 * The golden rule of the protocol: clients drive state purely from the event
 * log. `subscribe` carries the client's last-seen seq; the daemon replays the
 * gap, then streams live `event` messages. There is no separate "current state"
 * fetch that could race with live updates.
 */

// ── Client → Server ────────────────────────────────────────────────────────

export const ClientMessage = z.discriminatedUnion("type", [
  /**
   * Start watching a session. `lastSeq` is the highest seq this client already
   * has (-1 = brand new, wants full history). Daemon responds with `subscribed`
   * then a `replay`, then live `event`s.
   */
  z.object({
    type: z.literal("subscribe"),
    sessionId: z.string(),
    lastSeq: z.number().int().min(-1),
  }),

  z.object({
    type: z.literal("unsubscribe"),
    sessionId: z.string(),
  }),

  /** Immediately reassign the lock to this device and broadcast the change. */
  z.object({
    type: z.literal("take_control"),
    sessionId: z.string(),
  }),

  /**
   * Submit a finished prompt. Rejected (via `error`) unless this device is the
   * current controller. If the session is mid-turn, the prompt is queued
   * (see `prompt_queued`) and runs automatically as its own turn the instant
   * the session goes idle, rather than being rejected. `promptId` is a
   * client-generated id so the client can correlate its optimistic UI with the
   * resulting `prompt_submitted` event. `model`/`maxThinkingTokens`/
   * `permissionMode` are a per-message override (omit for the daemon's own
   * default); a fresh SDK query starts per prompt anyway, so there's no
   * mid-turn switch to support. `text` may be empty only if `attachments`
   * carries at least one file (SessionManager enforces this — not expressible
   * as a plain discriminated-union member's schema); `attachments` travel
   * inline as base64 and become real image/document content blocks for the
   * model, not a message about a file path.
   */
  z.object({
    type: z.literal("submit_prompt"),
    sessionId: z.string(),
    promptId: z.string(),
    text: z.string(),
    attachments: z.array(Attachment).max(MAX_ATTACHMENTS_PER_PROMPT).optional(),
    model: z.string().optional(),
    maxThinkingTokens: z.number().int().nullable().optional(),
    permissionMode: z.enum(["default", "acceptEdits", "plan", "auto"]).optional(),
  }),

  /** Answer a pending permission request. Only honored from the controller. */
  z.object({
    type: z.literal("resolve_permission"),
    sessionId: z.string(),
    requestId: z.string(),
    decision: PermissionDecision,
    /**
     * Replaces the tool's original input when allowing (e.g. `AskUserQuestion`,
     * where the client's chosen answers ARE the tool's result — there's no
     * other channel to return them). Ignored on `deny`.
     */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),

  /**
   * Stop the turn currently running for this session (the "stop" button).
   * Only honored from the controller, and only while a turn is actually
   * running — the daemon sends the SDK's graceful interrupt control request,
   * which lands as an ordinary `turn_result` (ok: false, interrupted: true).
   */
  z.object({
    type: z.literal("interrupt"),
    sessionId: z.string(),
  }),

  /**
   * Push a live permission-mode change to the turn currently running for this
   * session, if any — lets the controller flip modes (e.g. right after
   * resolving a pending approval) without waiting for the next prompt. Only
   * honored from the controller; a silent no-op daemon-side when the session
   * is idle, since the next `submit_prompt`'s own `permissionMode` already
   * carries the choice for that turn.
   */
  z.object({
    type: z.literal("set_permission_mode"),
    sessionId: z.string(),
    mode: z.enum(["default", "acceptEdits", "plan", "auto"]),
  }),

  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── Server → Client ──────────────────────────────────────────────────────────

export const ServerMessage = z.discriminatedUnion("type", [
  /** Ack of a subscribe; `currentSeq` is the log head at subscription time. */
  z.object({
    type: z.literal("subscribed"),
    sessionId: z.string(),
    currentSeq: z.number().int().min(-1),
  }),

  /** The gap-fill batch sent right after `subscribed`, oldest-first. */
  z.object({
    type: z.literal("replay"),
    sessionId: z.string(),
    events: z.array(SessionEvent),
    upToSeq: z.number().int().min(-1),
  }),

  /** A single live event appended after the client was caught up. */
  z.object({
    type: z.literal("event"),
    event: SessionEvent,
  }),

  /**
   * A recoverable, request-scoped error (e.g. "not the controller",
   * "session busy"). `ref` echoes a client id (like promptId) when relevant.
   */
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    ref: z.string().nullable(),
  }),

  /**
   * Fleet-wide push: some session's roster-relevant fields changed (status,
   * hasPendingPermission, controller, etc). Sent to every connected client
   * unconditionally — no subscribe needed — so a session list view can stay
   * live without polling. Independent of the per-session event log/replay.
   */
  z.object({
    type: z.literal("session"),
    session: Session,
  }),

  /** A session was permanently deleted (not archived — that's a `session` update). */
  z.object({
    type: z.literal("session_removed"),
    sessionId: z.string(),
  }),

  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Stable error codes so clients can branch without string-matching messages. */
export const WsErrorCode = {
  NotController: "not_controller",
  SessionBusy: "session_busy",
  SessionNotFound: "session_not_found",
  BadMessage: "bad_message",
  Unauthorized: "unauthorized",
  /** Daemon-side prompt queue for this session is already at its cap. */
  QueueFull: "queue_full",
  /** `interrupt` sent while no turn was running for this session. */
  NotBusy: "not_busy",
} as const;
export type WsErrorCode = (typeof WsErrorCode)[keyof typeof WsErrorCode];
