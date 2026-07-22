import type { PermissionMode, Query } from "@anthropic-ai/claude-agent-sdk";
import type { Session, SessionStatus } from "@crc/protocol";
import { desc, eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { EventLog } from "../events/log.js";
import { createWorktree, removeWorktree } from "../git/worktrees.js";
import { newSessionId } from "../ids.js";
import { logger } from "../logger.js";
import { findRepo } from "../repos.js";
import { hasCapabilities, setCapabilities } from "../claude/capabilities.js";
import { type PermissionResolver, runTurn } from "../claude/runner.js";
import { SessionError } from "./errors.js";

/**
 * SessionManager is the daemon's brain. Everything that mutates a session goes
 * through here so the invariants hold in ONE place:
 *   - exactly one controller (or none) at a time
 *   - a prompt only runs when the caller holds the lock AND the session is idle
 *   - every state change is both persisted to the sessions row AND recorded as
 *     an event (so live viewers and reconnecting clients see it identically)
 *
 * It is transport-agnostic: it knows nothing about WebSockets or HTTP. Step 2's
 * server is a thin adapter that calls these methods and forwards events.
 */
/** Injected by the rotator so a rate-limited turn can switch account + retry. */
export type RateLimitAutoSwitch = {
  autoRetryEnabled: boolean;
  rateLimitSwitch: () => Promise<{ switched: boolean; active: number | null }>;
};

/** Cap on how many prompts can pile up behind a busy session before we push back. */
export const MAX_QUEUED_PROMPTS = 20;

export type SubmitPromptInput = {
  sessionId: string;
  deviceId: string;
  promptId: string;
  text: string;
  resolvePermission: PermissionResolver;
  model?: string;
  maxThinkingTokens?: number | null;
  permissionMode?: PermissionMode;
};

export type SessionBroadcast = {
  /** A session's roster-relevant fields changed (status, controller, etc). */
  onSessionChanged: (session: Session) => void;
  /** A session was permanently deleted (archival is a status change, not this). */
  onSessionRemoved: (sessionId: string) => void;
};

export class SessionManager {
  readonly events: EventLog;
  private autoSwitch: RateLimitAutoSwitch | null = null;
  private broadcast: SessionBroadcast | null = null;
  /** sessionId -> prompts submitted while busy, FIFO; drained in submitPrompt's loop. */
  private readonly queues = new Map<string, SubmitPromptInput[]>();
  /** sessionId -> requestIds of permission_requests awaiting a decision. */
  private readonly pendingPermissions = new Map<string, Set<string>>();
  /** sessionId -> the live Query for its currently-running turn, if any (see interruptSession). */
  private readonly activeQueries = new Map<string, Query>();

  constructor(
    private readonly config: Config,
    private readonly db: DB,
  ) {
    this.events = new EventLog(db);
  }

  /** Wire the account rotator in (set once at startup; avoids a ctor cycle). */
  setAutoSwitch(autoSwitch: RateLimitAutoSwitch): void {
    this.autoSwitch = autoSwitch;
  }

  /** Wire the fleet-wide WS broadcaster in (set once at startup; avoids a ctor cycle). */
  setBroadcast(broadcast: SessionBroadcast): void {
    this.broadcast = broadcast;
  }

  // ── Creation / listing / teardown ──────────────────────────────────────────

  async createSession(input: {
    repoId: string;
    baseBranch: string;
    newBranch?: string;
    title?: string;
  }): Promise<Session> {
    const repo = await findRepo(this.config, input.repoId);
    if (!repo) throw new SessionError("repo_not_found", `Unknown repo: ${input.repoId}`);

    const id = newSessionId();
    const { worktreePath, branch } = await createWorktree(
      this.config,
      repo.path,
      id,
      input.baseBranch,
      input.newBranch,
    );

    const now = Date.now();
    const row = {
      id,
      repoId: repo.id,
      repoName: repo.name,
      baseBranch: input.baseBranch,
      branch,
      worktreePath,
      status: "idle" as SessionStatus,
      hasPendingPermission: false,
      controller: null,
      claudeSessionId: null,
      title: input.title ?? null,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    this.db.insert(sessions).values(row).run();

    // First events in the log: the session's birth certificate + its initial
    // status. Recording status here means the log fully describes state from
    // seq 0 — a client can fold it and know the session is idle without any
    // out-of-band snapshot.
    this.events.append(id, {
      kind: "session_created",
      repoId: repo.id,
      repoName: repo.name,
      baseBranch: input.baseBranch,
      branch,
      worktreePath,
    });
    this.events.append(id, { kind: "status_changed", status: "idle" });

    logger.info("session created", { id, repo: repo.name, branch });
    const session = rowToSession(row);
    this.broadcast?.onSessionChanged(session);
    return session;
  }

  listSessions(): Session[] {
    return this.db.select().from(sessions).orderBy(desc(sessions.lastActivityAt)).all().map(rowToSession);
  }

  getSession(id: string): Session {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) throw new SessionError("session_not_found", `Unknown session: ${id}`);
    return rowToSession(row);
  }

  async archiveSession(id: string): Promise<Session> {
    const repo = await findRepo(this.config, this.getSession(id).repoId);
    const session = this.getSession(id);
    if (repo) {
      await removeWorktree(repo.path, session.worktreePath, session.branch).catch((err) =>
        logger.warn("worktree cleanup failed during archive", { id, err: String(err) }),
      );
    }
    this.patch(id, { status: "archived", controller: null });
    this.events.append(id, { kind: "status_changed", status: "archived" });
    this.events.append(id, { kind: "control_changed", controller: null, controllerName: null });
    this.pendingPermissions.delete(id);
    logger.info("session archived", { id });
    return this.getSession(id);
  }

  /**
   * Permanently remove a session: unlike archive, this drops the DB row and its
   * whole event log too — no transcript history kept. Cleans up the worktree
   * first if it hasn't already been (archived sessions have none left).
   */
  async deleteSession(id: string): Promise<void> {
    const session = this.getSession(id);
    if (session.status !== "archived") {
      const repo = await findRepo(this.config, session.repoId);
      if (repo) {
        await removeWorktree(repo.path, session.worktreePath, session.branch).catch((err) =>
          logger.warn("worktree cleanup failed during delete", { id, err: String(err) }),
        );
      }
    }
    this.events.deleteAll(id);
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
    this.pendingPermissions.delete(id);
    this.broadcast?.onSessionRemoved(id);
    logger.info("session deleted", { id });
  }

  // ── Take-control locking ────────────────────────────────────────────────────

  takeControl(id: string, deviceId: string, deviceName?: string): Session {
    const session = this.getSession(id);
    if (session.status === "archived") throw new SessionError("session_archived", "Session is archived.");
    if (session.controller === deviceId) return session; // already in control; no-op

    this.patch(id, { controller: deviceId });
    this.events.append(id, {
      kind: "control_changed",
      controller: deviceId,
      controllerName: deviceName ?? null,
    });
    logger.info("control taken", { id, deviceId });
    return this.getSession(id);
  }

  releaseControl(id: string, deviceId: string): Session {
    const session = this.getSession(id);
    if (session.controller !== deviceId) return session; // not holding it; no-op
    this.patch(id, { controller: null });
    this.events.append(id, { kind: "control_changed", controller: null, controllerName: null });
    logger.info("control released", { id, deviceId });
    return this.getSession(id);
  }

  // ── Prompting ────────────────────────────────────────────────────────────────

  /**
   * Submit a finished prompt. Enforces the lock; if the session is idle, runs
   * it as a turn immediately (and keeps draining anything queued behind it —
   * each queued prompt becomes its own ordinary turn the instant the previous
   * one finishes). If the session is busy, the prompt is held in a per-session
   * FIFO queue instead of being rejected — this is the only difference from
   * before, not a new execution model. The `resolvePermission` policy decides
   * tool-use requests (in Step 2 this asks the controller over WS).
   */
  async submitPrompt(input: SubmitPromptInput): Promise<void> {
    const session = this.getSession(input.sessionId);
    if (session.status === "archived") throw new SessionError("session_archived", "Session is archived.");
    if (session.controller !== input.deviceId)
      throw new SessionError("not_controller", "Only the controlling device can send prompts.");

    if (session.status === "busy") {
      const queue = this.queues.get(input.sessionId) ?? [];
      if (queue.length >= MAX_QUEUED_PROMPTS)
        throw new SessionError("queue_full", "Too many prompts queued for this session.");
      queue.push(input);
      this.queues.set(input.sessionId, queue);
      this.events.append(input.sessionId, {
        kind: "prompt_queued",
        promptId: input.promptId,
        deviceId: input.deviceId,
        text: input.text,
      });
      return;
    }

    let next: SubmitPromptInput | undefined = input;
    while (next) {
      await this.runOneTurn(next);
      next = this.queues.get(next.sessionId)?.shift();
    }
  }

  /** Runs exactly one Claude turn for an already-idle session. */
  private async runOneTurn(input: SubmitPromptInput): Promise<void> {
    const session = this.getSession(input.sessionId);

    // Flip to busy and record the prompt BEFORE any await, so a concurrent
    // submit for the same session loses the race and gets queued instead.
    this.patch(input.sessionId, { status: "busy", lastActivityAt: Date.now() });
    this.events.append(input.sessionId, { kind: "status_changed", status: "busy" });
    this.events.append(input.sessionId, {
      kind: "prompt_submitted",
      promptId: input.promptId,
      deviceId: input.deviceId,
      text: input.text,
    });

    let resumeId = session.claudeSessionId;
    const runOnce = () =>
      runTurn({
        cwd: session.worktreePath,
        resumeSessionId: resumeId,
        prompt: input.text,
        promptId: input.promptId,
        model: input.model,
        maxThinkingTokens: input.maxThinkingTokens,
        permissionMode: input.permissionMode,
        forcePermissionPrompts: this.config.forcePermissionPrompts,
        enableRtk: this.config.enableRtk,
        rtkBin: this.config.rtkBin,
        emit: (payload) => {
          if (payload.kind === "permission_request") this.trackPendingPermission(input.sessionId, payload.requestId, true);
          else if (payload.kind === "permission_resolved") this.trackPendingPermission(input.sessionId, payload.requestId, false);
          this.events.append(input.sessionId, payload);
        },
        resolvePermission: input.resolvePermission,
        // Cheap to skip once the daemon already knows this — it's static per
        // `claude` install, not per-session.
        onCapabilities: hasCapabilities() ? undefined : setCapabilities,
        onQuery: (q) => this.activeQueries.set(input.sessionId, q),
      });

    // Cleared as soon as each attempt settles so interruptSession can never act
    // on a stale Query from a turn that's already finished.
    let result: Awaited<ReturnType<typeof runOnce>>;
    try {
      result = await runOnce();
    } finally {
      this.activeQueries.delete(input.sessionId);
    }
    resumeId = result.claudeSessionId ?? resumeId;

    // Rate-limit auto-rotation: if the turn failed because the account hit its
    // limit, switch to the other account and retry the SAME prompt exactly once.
    // The turn has already ended, so this swap is at a clean boundary — never
    // mid-flight. Once only, so two exhausted accounts can't loop.
    if (!result.ok && result.rateLimited && this.autoSwitch?.autoRetryEnabled) {
      this.events.append(input.sessionId, { kind: "notice", text: "Usage limit hit — switching account…", level: "warn" });
      const sw = await this.autoSwitch.rateLimitSwitch();
      if (sw.switched) {
        this.events.append(input.sessionId, {
          kind: "notice",
          text: `Switched account${sw.active ? ` (now #${sw.active})` : ""} — retrying.`,
          level: "info",
        });
        try {
          result = await runOnce();
        } finally {
          this.activeQueries.delete(input.sessionId);
        }
        resumeId = result.claudeSessionId ?? resumeId;
      } else {
        this.events.append(input.sessionId, { kind: "notice", text: "No other account available to switch to.", level: "warn" });
      }
    }

    const nextStatus: SessionStatus = result.ok ? "idle" : "error";
    this.patch(input.sessionId, {
      status: nextStatus,
      claudeSessionId: resumeId,
      lastActivityAt: Date.now(),
    });
    this.events.append(input.sessionId, { kind: "status_changed", status: nextStatus });
  }

  /**
   * Stop the turn currently running for this session (the "stop" button).
   * Sends the SDK's graceful interrupt control request — the turn still ends
   * through the normal `runTurn` result path (a `turn_result` with
   * `interrupted: true`), just early, so no separate event kind is needed here.
   */
  interruptSession(id: string, deviceId: string): void {
    const session = this.getSession(id);
    if (session.controller !== deviceId) throw new SessionError("not_controller", "Only the controller can stop a turn.");
    const q = this.activeQueries.get(id);
    if (!q) throw new SessionError("not_busy", "No turn is running to stop.");
    q.interrupt().catch((err) => logger.warn("interrupt failed", { id, err: String(err) }));
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Keep `hasPendingPermission` in sync with the set of unresolved requestIds. */
  private trackPendingPermission(sessionId: string, requestId: string, pending: boolean): void {
    const set = this.pendingPermissions.get(sessionId) ?? new Set<string>();
    const had = set.size > 0;
    if (pending) set.add(requestId);
    else set.delete(requestId);

    if (set.size > 0) this.pendingPermissions.set(sessionId, set);
    else this.pendingPermissions.delete(sessionId);

    const has = set.size > 0;
    if (has !== had) this.patch(sessionId, { hasPendingPermission: has });
  }

  private patch(id: string, fields: Partial<typeof sessions.$inferInsert>): void {
    this.db
      .update(sessions)
      .set({ ...fields, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
    this.broadcast?.onSessionChanged(this.getSession(id));
  }
}

function rowToSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    repoId: row.repoId,
    repoName: row.repoName,
    baseBranch: row.baseBranch,
    branch: row.branch,
    worktreePath: row.worktreePath,
    status: row.status as SessionStatus,
    hasPendingPermission: row.hasPendingPermission,
    controller: row.controller,
    claudeSessionId: row.claudeSessionId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
  };
}
