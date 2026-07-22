import type { PermissionMode, Query } from "@anthropic-ai/claude-agent-sdk";
import type { MergeConflictMeta, Session, SessionPurpose, SessionStatus } from "@crc/protocol";
import { desc, eq, ne } from "drizzle-orm";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
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
import { derivePlaceholderTitle, generateSessionTitle } from "../claude/titler.js";
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

/** Cap on how many turns we'll keep trying to upgrade a placeholder title before giving up on it for good. */
export const TITLE_UPGRADE_ATTEMPT_CAP = 6;

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

  /**
   * Call once at boot. `activeQueries`/`pendingPermissions`/`queues` all start
   * empty on a fresh process, so any session row still `busy` from before a
   * hard restart (crash, `kill -9`, `pm2 restart` mid-turn) has no live Query
   * backing it and never will again. Left alone it's wedged forever: Stop
   * throws `not_busy` (no entry in `activeQueries`), and a new prompt just
   * piles into the queue behind a turn that can never finish. Mark the
   * dangling turn (and any dangling permission request) resolved so the
   * session goes back to being usable.
   *
   * Doesn't touch any `prompt_queued` events left behind the dangling turn —
   * those stay visible as "queued" in clients until the user resends; draining
   * them automatically would mean re-running arbitrary prompts unattended at
   * boot, which is out of scope for what's otherwise a display-only wedge.
   */
  reconcileOrphanedTurns(): void {
    const stuck = this.db.select().from(sessions).where(eq(sessions.status, "busy")).all();
    for (const row of stuck) {
      const id = row.id;
      const log = this.events.read(id);

      // Walk the log to find the last prompt that never got a turn_result,
      // and whatever turnId (if any) it had already started streaming under
      // by the time the process died.
      let orphanPromptId: string | null = null;
      let orphanTurnId: string | null = null;
      for (const e of log) {
        if (e.kind === "prompt_submitted") {
          orphanPromptId = e.promptId;
          orphanTurnId = null;
        } else if (e.kind === "turn_result" && e.promptId === orphanPromptId) {
          orphanPromptId = null;
          orphanTurnId = null;
        } else if (
          orphanPromptId &&
          (e.kind === "assistant_delta" || e.kind === "assistant_block" || e.kind === "tool_result" || e.kind === "permission_request")
        ) {
          orphanTurnId = e.turnId;
        }
      }

      if (orphanPromptId) {
        this.events.append(id, {
          kind: "turn_result",
          turnId: orphanTurnId ?? `orphan-${orphanPromptId}`,
          promptId: orphanPromptId,
          ok: false,
          costUsd: null,
          durationMs: null,
          errorMessage: "Daemon restarted while this turn was running — resend the prompt.",
          inputTokens: null,
          outputTokens: null,
          interrupted: false,
        });
        logger.warn("reconciled orphaned turn on boot", { id, promptId: orphanPromptId });
      }

      // Any permission request left unresolved would keep hasPendingPermission
      // stuck true for the same reason — deny rather than allow, since the
      // gated tool call never got a live turn to actually run it.
      const openRequestIds = new Set<string>();
      for (const e of log) {
        if (e.kind === "permission_request") openRequestIds.add(e.requestId);
        else if (e.kind === "permission_resolved") openRequestIds.delete(e.requestId);
      }
      for (const requestId of openRequestIds) {
        this.events.append(id, { kind: "permission_resolved", requestId, decision: "deny", byDeviceId: null });
      }

      this.patch(id, { status: "error", hasPendingPermission: false });
      this.events.append(id, { kind: "status_changed", status: "error" });
    }
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

  /** Omit `repoId` for a repo-less session: a plain scratch directory, no git worktree, just for chatting. */
  async createSession(input: {
    repoId?: string;
    baseBranch?: string;
    newBranch?: string;
    title?: string;
  }): Promise<Session> {
    const id = newSessionId();
    const created = input.repoId
      ? await this.createRepoSession(id, input.repoId, input.baseBranch, input.newBranch)
      : this.createPlainSession(id);

    return this.finalizeNewSession(id, { ...created, purpose: "normal", mergeMeta: null }, input.title);
  }

  /**
   * Attach a new session to a worktree that ALREADY exists on disk, instead of
   * having createWorktree make one — used when an automated merge conflicts:
   * the scratch worktree from `attemptMerge` (git/merge.ts), conflict markers
   * and all, becomes this session's live workspace so Claude can resolve the
   * conflict in place rather than being handed a diff to reason about blind.
   */
  async createConflictResolutionSession(input: {
    repoId: string;
    repoName: string;
    branch: string;
    worktreePath: string;
    mergeMeta: MergeConflictMeta;
    title?: string;
  }): Promise<Session> {
    const id = newSessionId();
    const created = {
      repoId: input.repoId,
      repoName: input.repoName,
      baseBranch: input.mergeMeta.targetBranch,
      branch: input.branch,
      worktreePath: input.worktreePath,
      purpose: "merge_conflict" as const,
      mergeMeta: input.mergeMeta,
    };
    return this.finalizeNewSession(id, created, input.title);
  }

  private async createRepoSession(id: string, repoId: string, baseBranch: string | undefined, newBranch: string | undefined) {
    const repo = await findRepo(this.config, repoId);
    if (!repo) throw new SessionError("repo_not_found", `Unknown repo: ${repoId}`);
    if (!baseBranch) throw new SessionError("invalid_request", "baseBranch is required when repoId is set");

    const { worktreePath, branch } = await createWorktree(this.config, repo.path, id, baseBranch, newBranch);
    return { repoId: repo.id, repoName: repo.name, baseBranch, branch, worktreePath };
  }

  /** Shared tail of session creation: persist the row, seed the log's birth certificate, broadcast. */
  private finalizeNewSession(
    id: string,
    created: {
      repoId: string | null;
      repoName: string;
      baseBranch: string | null;
      branch: string | null;
      worktreePath: string;
      purpose: SessionPurpose;
      mergeMeta: MergeConflictMeta | null;
    },
    title: string | undefined,
  ): Session {
    const now = Date.now();
    const row = {
      id,
      ...created,
      mergeMeta: created.mergeMeta ? JSON.stringify(created.mergeMeta) : null,
      status: "idle" as SessionStatus,
      hasPendingPermission: false,
      controller: null,
      claudeSessionId: null,
      title: title ?? null,
      // A manual title here is never touched by the auto-titler (see runOneTurn),
      // so it doesn't need "manual" bookkeeping — null just means "not a placeholder".
      titleSource: null,
      titleGenAttempts: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    this.db.insert(sessions).values(row).run();

    // First events in the log: the session's birth certificate + its initial
    // status. Recording status here means the log fully describes state from
    // seq 0 — a client can fold it and know the session is idle without any
    // out-of-band snapshot.
    this.events.append(id, { kind: "session_created", ...created });
    this.events.append(id, { kind: "status_changed", status: "idle" });

    logger.info("session created", { id, repo: created.repoName, branch: created.branch, purpose: created.purpose });
    const session = rowToSession(row);
    this.broadcast?.onSessionChanged(session);
    return session;
  }

  /** A plain directory with nothing checked out — just somewhere for Claude to chat/scratch, no git involved. */
  private createPlainSession(id: string) {
    const worktreePath = resolve(this.config.dataDir, "chats", id);
    mkdirSync(worktreePath, { recursive: true });
    return { repoId: null, repoName: "No repo", baseBranch: null, branch: null, worktreePath };
  }

  listSessions(): Session[] {
    return this.db
      .select()
      .from(sessions)
      .where(ne(sessions.status, "deleted"))
      .orderBy(desc(sessions.lastActivityAt))
      .all()
      .map(rowToSession);
  }

  getSession(id: string): Session {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row || row.status === "deleted") throw new SessionError("session_not_found", `Unknown session: ${id}`);
    return rowToSession(row);
  }

  async archiveSession(id: string): Promise<Session> {
    await this.cleanUpWorkdir(this.getSession(id)).catch((err) =>
      logger.warn("workdir cleanup failed during archive", { id, err: String(err) }),
    );
    this.patch(id, { status: "archived", controller: null });
    this.events.append(id, { kind: "status_changed", status: "archived" });
    this.events.append(id, { kind: "control_changed", controller: null, controllerName: null });
    this.pendingPermissions.delete(id);
    logger.info("session archived", { id });
    return this.getSession(id);
  }

  /**
   * Permanently remove a session: wipes its transcript and worktree — no
   * content or history kept, not shown or resumable. Unlike an old-style full
   * delete, the DB row itself survives as a tombstone (repoId/repoName plus
   * status "deleted"), stripped of everything else, so its turn_result events
   * (which we also keep, see EventLog.deleteTranscript) keep attributing to
   * the right repo in stats forever. listSessions()/getSession() both exclude
   * "deleted" rows, so tombstones are invisible everywhere except stats.
   */
  async deleteSession(id: string): Promise<void> {
    const session = this.getSession(id);
    if (session.status !== "archived") {
      await this.cleanUpWorkdir(session).catch((err) =>
        logger.warn("workdir cleanup failed during delete", { id, err: String(err) }),
      );
    }
    this.events.deleteTranscript(id);
    this.db
      .update(sessions)
      .set({
        status: "deleted",
        controller: null,
        claudeSessionId: null,
        title: null,
        titleSource: null,
        hasPendingPermission: false,
        worktreePath: "",
        updatedAt: Date.now(),
      })
      .where(eq(sessions.id, id))
      .run();
    this.pendingPermissions.delete(id);
    this.broadcast?.onSessionRemoved(id);
    logger.info("session deleted", { id });
  }

  /** Tear down a session's on-disk working directory: a git worktree for a repo session, or just the plain scratch dir. */
  private async cleanUpWorkdir(session: Session): Promise<void> {
    if (!session.repoId) {
      rmSync(session.worktreePath, { recursive: true, force: true });
      return;
    }
    const repo = await findRepo(this.config, session.repoId);
    if (repo && session.branch) await removeWorktree(repo.path, session.worktreePath, session.branch);
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

    // Instant, LLM-free placeholder — shown right away (same idea as the
    // VSCode extension's "title = your first message" before it upgrades it).
    // Only the very first prompt of a session ever sees `title === null` here.
    if (session.title == null) {
      this.patch(input.sessionId, { title: derivePlaceholderTitle(input.text), titleSource: "placeholder", titleGenAttempts: 0 });
    }

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

    // Fire-and-forget, started only now that the turn's own assistant text is
    // already in the log: attempting this BEFORE the turn ran (the previous
    // approach) meant the very first attempt ever had nothing but the user's
    // raw prompt to go on — for a vague first message ("what does this do?")
    // that's indistinguishable from no context at all, so the model bailed
    // every time and the session was stuck on its placeholder for good.
    // Capped so a session that never gives the model "enough" (e.g. genuinely
    // contentless turns) just keeps its placeholder for good.
    {
      const { titleSource, titleGenAttempts } = this.titleState(input.sessionId);
      if (titleSource === "placeholder" && titleGenAttempts < TITLE_UPGRADE_ATTEMPT_CAP) {
        this.tryUpgradeTitle(input.sessionId, session.worktreePath);
      }
    }
  }

  /** Raw title bookkeeping columns — internal only, not part of the public `Session` type. */
  private titleState(id: string): { titleSource: string | null; titleGenAttempts: number } {
    const row = this.db
      .select({ titleSource: sessions.titleSource, titleGenAttempts: sessions.titleGenAttempts })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    return row ?? { titleSource: null, titleGenAttempts: 0 };
  }

  /**
   * One attempt at upgrading a placeholder title using the conversation so
   * far; a no-op once a manual rename or a prior success has taken title
   * ownership away from "placeholder".
   *
   * Includes the assistant's final text blocks, not just the user's prompts:
   * a vague first message ("what does this do?") never gets more specific on
   * its own no matter how many follow-ups repeat the question — the actual
   * substance for a good title lives in what the assistant found and said.
   */
  private async tryUpgradeTitle(sessionId: string, cwd: string): Promise<void> {
    const transcript = this.events
      .read(sessionId)
      .flatMap((e) => {
        if (e.kind === "prompt_submitted") return [`User: ${e.text}`];
        if (e.kind === "assistant_block" && e.blockKind === "text" && e.text) return [`Assistant: ${e.text}`];
        return [];
      })
      .join("\n");

    const title = await generateSessionTitle(cwd, transcript);
    try {
      const state = this.titleState(sessionId);
      if (state.titleSource !== "placeholder") return;
      if (title) this.patch(sessionId, { title, titleSource: "generated" });
      else this.patch(sessionId, { titleGenAttempts: state.titleGenAttempts + 1 });
    } catch (err) {
      logger.warn("title upgrade failed to apply", { sessionId, err: String(err) });
    }
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

  /**
   * Push a live permission-mode change to the turn currently running for this
   * session, if any, via the SDK's mid-session control request. Lets a
   * controller flip e.g. Manual -> Auto right after answering a pending
   * approval, so the rest of that same turn stops asking instead of only
   * affecting the NEXT `submitPrompt`. Silently a no-op when idle — nothing
   * live to update, and the next turn already carries the new mode itself.
   */
  setPermissionMode(id: string, deviceId: string, mode: PermissionMode): void {
    const session = this.getSession(id);
    if (session.controller !== deviceId)
      throw new SessionError("not_controller", "Only the controller can change permission mode.");
    const q = this.activeQueries.get(id);
    if (!q) return;
    q.setPermissionMode(mode).catch((err) => logger.warn("setPermissionMode failed", { id, err: String(err) }));
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
    purpose: row.purpose as SessionPurpose,
    mergeMeta: row.mergeMeta ? (JSON.parse(row.mergeMeta) as MergeConflictMeta) : null,
  };
}
