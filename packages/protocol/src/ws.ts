import { z } from "zod";
import { Attachment, MAX_ATTACHMENTS_PER_PROMPT, UploadRef } from "./attachments.js";
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

/** One homelab gateway request waiting for the phone (see ServerMessage gateway_approvals). Times in ms. */
export const GatewayApproval = z.object({ id: z.string(), verb: z.string(), summary: z.string(), created: z.number(), expires: z.number() });
export type GatewayApproval = z.infer<typeof GatewayApproval>;

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
    /**
     * Replay attachments as references (AttachmentView.ref) rather than their
     * bytes; the client fetches each one when it's shown. Optional, so older
     * clients keep getting the data inline and older daemons ignore it.
     */
    lazyAttachments: z.boolean().optional(),
    /**
     * Opening the chat with nothing loaded (lastSeq -1): send its folded
     * state with only the last this-many timeline items, as a `snapshot`,
     * instead of replaying every event. The rest comes from
     * GET /sessions/:id/history. Older daemons ignore it and replay.
     */
    tail: z.number().int().positive().optional(),
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
   * model, not a message about a file path. `timeZone` is the sending
   * device's IANA zone, so Claude can give times in the user's clock rather
   * than the host's.
   */
  z.object({
    type: z.literal("submit_prompt"),
    sessionId: z.string(),
    promptId: z.string(),
    text: z.string(),
    attachments: z.array(Attachment).max(MAX_ATTACHMENTS_PER_PROMPT).optional(),
    /** Files uploaded beforehand (POST /uploads), by reference: see UploadRef. */
    uploads: z.array(UploadRef).max(MAX_ATTACHMENTS_PER_PROMPT).optional(),
    model: z.string().optional(),
    maxThinkingTokens: z.number().int().nullable().optional(),
    permissionMode: z.enum(["default", "acceptEdits", "plan", "auto"]).optional(),
    timeZone: z.string().max(64).optional(),
  }),

  /**
   * Give the lock back (a script that only came to send one message). Only
   * honored from the controller; a no-op otherwise.
   */
  z.object({
    type: z.literal("release_control"),
    sessionId: z.string(),
  }),

  /**
   * Answer a pending permission request. Honored from the controller, or from
   * any device while the controller isn't connected (it then takes control).
   */
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
   * "Send now" on a message sent mid-turn: move the step Claude is waiting on
   * (a foreground command or agent) to the background, so it reads the
   * message at once. The work keeps running. Controller only.
   */
  z.object({
    type: z.literal("send_now"),
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

  /**
   * Act on a session's scheduled resume (see Session.resume): "cancel" drops
   * it, "now" tries straight away instead of waiting for the reset. Honored
   * from the controller, or from anyone while nobody holds the lock — a resume
   * is often acted on hours later, after the lock has been auto-released.
   */
  z.object({
    type: z.literal("resume_action"),
    sessionId: z.string(),
    action: z.enum(["cancel", "now"]),
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

  /**
   * Instead of `replay` when the subscribe asked for a `tail`: the chat folded
   * up to `upToSeq` (client-core's ConversationState, attachments by
   * reference), holding only its latest timeline items. `state.olderItems`
   * says how many come before them.
   */
  z.object({
    type: z.literal("snapshot"),
    sessionId: z.string(),
    state: z.record(z.string(), z.unknown()),
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

  /**
   * Homelab gateway requests waiting for the user's phone (add-app, rm-path…),
   * sent on connect and whenever the list changes. Only what the phone will
   * show; approving still happens on the phone alone.
   */
  /** `window`: while a time window is open (`homelab open-window`), when it closes, in ms; null when none. */
  z.object({ type: z.literal("gateway_approvals"), pending: z.array(GatewayApproval), window: z.number().nullable().optional() }),

  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Stable error codes so clients can branch without string-matching messages. */
export const WsErrorCode = {
  NotController: "not_controller",
  SessionBusy: "session_busy",
  /** Prompting or taking control of a session that is sitting in the trash. */
  SessionTrashed: "session_trashed",
  SessionNotFound: "session_not_found",
  BadMessage: "bad_message",
  Unauthorized: "unauthorized",
  /** Daemon-side prompt queue for this session is already at its cap. */
  QueueFull: "queue_full",
  /** `interrupt` sent while no turn was running for this session. */
  NotBusy: "not_busy",
  /**
   * `resolve_permission` for a request nothing is waiting on any more (answered
   * elsewhere, timed out, cancelled by Claude, or from before a restart).
   * `ref` is its requestId; clients just drop the card.
   */
  PermissionGone: "permission_gone",
  /** `resume_action` sent for a session with no resume scheduled. */
  NoResume: "no_resume",
} as const;
export type WsErrorCode = (typeof WsErrorCode)[keyof typeof WsErrorCode];
