import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  Attachment,
  EventPayload,
  MergeConflictMeta,
  Session,
  SessionComposerPatch,
  SessionPurpose,
  SessionStatus,
} from "@renki/protocol";
import { desc, eq, isNotNull, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
import { LiveClaudeSession } from "../claude/liveSession.js";
import type { ResumePlan, ResumeReadiness } from "../accounts/resumePlan.js";
import type { PermissionResolver, RateLimitHit, RunTurnResult } from "../claude/runner.js";
import { derivePlaceholderTitle, generateSessionTitle } from "../claude/titler.js";
import { SessionError } from "./errors.js";
import { dueForPurge, purgeAtFor } from "./trash.js";

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
/** Injected by the rotator so a rate-limited turn can switch account + retry, or wait for a reset. */
export type RateLimitAutoSwitch = {
  autoRetryEnabled: boolean;
  /** `reason` explains a `switched: false` outcome; it goes straight into the transcript. */
  rateLimitSwitch: () => Promise<{ switched: boolean; active: number | null; reason?: string }>;
  autoResumeEnabled: boolean;
  planResume: (input: { model: string | null; hit: RateLimitHit | null; attempt: number }) => Promise<ResumePlan>;
  prepareResume: (model: string | null) => Promise<ResumeReadiness>;
};

/**
 * What a waiting resume will send, persisted as JSON in `sessions.resume_state`.
 * The permission resolver can't be stored, and doesn't need to be: it's per
 * session, so the one in effect when the resume runs is rebuilt then.
 */
type ResumeState = {
  reason: string;
  attempt: number;
  prompt: {
    deviceId: string;
    text: string;
    attachments?: Attachment[];
    model?: string;
    maxThinkingTokens?: number | null;
    permissionMode?: PermissionMode;
  };
};

/**
 * Give up waiting after this many resumed attempts also hit a limit. Each wait
 * is until an actual reset, so this is days of trying, not a tight loop — the
 * cap is for a limit that genuinely never clears (a plan with no allowance for
 * the model, say), which would otherwise be retried forever.
 */
export const MAX_RESUME_ATTEMPTS = 8;

/**
 * Sent instead of the original prompt when the turn got partway before the
 * limit stopped it. The transcript already has the prompt and the work done
 * so far; sending the prompt again would read as a new request to start over.
 */
export const RESUME_CONTINUE_TEXT = "Your usage limit has reset. Continue where you left off.";

/** Timers are re-armed in steps no longer than this, well inside setTimeout's ~24.8-day ceiling. */
const MAX_TIMER_STEP_MS = 6 * 60 * 60_000;

/** Cap on how many prompts can pile up behind a busy session before we push back. */
export const MAX_QUEUED_PROMPTS = 20;

/** Cap on how many turns we'll keep trying to upgrade a placeholder title before giving up on it for good. */
export const TITLE_UPGRADE_ATTEMPT_CAP = 6;

export type SubmitPromptInput = {
  sessionId: string;
  deviceId: string;
  promptId: string;
  text: string;
  attachments?: Attachment[];
  resolvePermission: PermissionResolver;
  model?: string;
  maxThinkingTokens?: number | null;
  permissionMode?: PermissionMode;
  /** Set on a prompt the daemon re-sent after a limit reset: how many waits came before it. */
  resumeAttempt?: number;
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
  /**
   * sessionId -> its long-lived `claude` process, created on the first prompt
   * and kept alive between turns so background agents survive the turn that
   * spawned them (see LiveClaudeSession). Reaped after `config.liveIdleMs` of
   * silence, closed on archive/delete/shutdown; the conversation itself lives
   * in the resumable transcript, so a closed process costs nothing but the
   * next prompt's spawn time.
   */
  private readonly live = new Map<string, LiveClaudeSession>();
  private reaper: NodeJS.Timeout | null = null;
  /**
   * Sessions currently inside runOneTurn (between flipping busy and settling).
   * An "auto turn" (the CLI acting on its own, e.g. reacting to a background
   * agent finishing) must not flip such a session's status underneath it.
   */
  private readonly promptedTurns = new Set<string>();
  /** sessionId -> the timer that will run its scheduled resume (see scheduleResume). */
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  /** Builds the permission resolver for a resumed turn — the broker's, wired in at startup. */
  private resolverFor: ((sessionId: string) => PermissionResolver) | null = null;
  /** Set by closeAll: a shutting-down daemon must not start resumed turns. */
  private stopping = false;
  /** Sessions inside runResume's readiness check, so the timer and "Continue now" can't both start the turn. */
  private readonly resuming = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly db: DB,
  ) {
    this.events = new EventLog(db);
  }

  /**
   * Call once at boot. `live`/`pendingPermissions`/`queues` all start empty
   * on a fresh process, so any session row still `busy` from before a hard
   * restart (crash, `kill -9`, `pm2 restart` mid-turn) has no live process
   * backing it and never will again. Left alone it's wedged forever: Stop
   * throws `not_busy` (no entry in `live`), and a new prompt just
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

  /** Wire in how resumed turns ask for permissions (set once at startup; the broker lives in the server layer). */
  setPermissionResolverFactory(fn: (sessionId: string) => PermissionResolver): void {
    this.resolverFor = fn;
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
    /** The creating device's composer defaults — read once, here, and then owned by the session. */
    composer?: SessionComposerPatch;
  }): Promise<Session> {
    const id = newSessionId();
    const created = input.repoId
      ? await this.createRepoSession(id, input.repoId, input.baseBranch, input.newBranch)
      : this.createPlainSession(id);

    return this.finalizeNewSession(id, { ...created, purpose: "normal", mergeMeta: null }, input.title, input.composer);
  }

  /**
   * Repin some of a session's composer settings. Omitted fields keep their
   * current value, so two devices editing different pickers don't clobber each
   * other, and an explicit null clears one back to the client's own default.
   *
   * Goes through `patch`, so every connected client gets the new session object
   * pushed immediately — which is the whole point: change the model on a laptop
   * and the phone's picker follows without a refresh.
   */
  setSessionComposer(id: string, composer: SessionComposerPatch): Session {
    this.getSession(id); // throws session_not_found if missing/deleted
    const fields: Partial<typeof sessions.$inferInsert> = {};
    if (composer.model !== undefined) fields.composerModel = composer.model;
    if (composer.effortKey !== undefined) fields.composerEffortKey = composer.effortKey;
    if (composer.permissionMode !== undefined) fields.composerPermissionMode = composer.permissionMode;
    if (Object.keys(fields).length > 0) this.patch(id, fields);
    return this.getSession(id);
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
    composer?: SessionComposerPatch,
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
      trashedAt: null,
      trashedFrom: null,
      lastModel: null,
      // Seeded from whichever device created the session; null wherever that
      // device had no preference, which the client reads as "use my default".
      composerModel: composer?.model ?? null,
      composerEffortKey: composer?.effortKey ?? null,
      composerPermissionMode: composer?.permissionMode ?? null,
      resumeAt: null,
      resumeState: null,
    };
    this.db.insert(sessions).values(row).run();

    // First events in the log: the session's birth certificate + its initial
    // status. Recording status here means the log fully describes state from
    // seq 0 — a client can fold it and know the session is idle without any
    // out-of-band snapshot.
    this.events.append(id, { kind: "session_created", ...created });
    this.events.append(id, { kind: "status_changed", status: "idle" });

    logger.info("session created", { id, repo: created.repoName, branch: created.branch, purpose: created.purpose });
    const session = rowToSession(row, this.config.trashRetentionMs);
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
      .map((row) => rowToSession(row, this.config.trashRetentionMs));
  }

  getSession(id: string): Session {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row || row.status === "deleted") throw new SessionError("session_not_found", `Unknown session: ${id}`);
    return rowToSession(row, this.config.trashRetentionMs);
  }

  async archiveSession(id: string): Promise<Session> {
    this.closeLive(id, "archived");
    this.clearResume(id);
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
   * Manual rename — takes title ownership away from the auto-titler for
   * good, the same way a `title` supplied at creation already does (see
   * `finalizeNewSession`): `tryUpgradeTitle` only ever touches a title whose
   * `titleSource` is still `"placeholder"`, so setting it to `"manual"` here
   * makes this permanent regardless of how many upgrade attempts are left.
   */
  renameSession(id: string, title: string): Session {
    this.getSession(id); // throws session_not_found if missing/deleted
    this.patch(id, { title, titleSource: "manual" });
    logger.info("session renamed", { id });
    return this.getSession(id);
  }

  /**
   * Move a session to the trash — the ordinary "delete".
   *
   * Think of it as **archive plus a timer**: the worktree and branch are torn
   * down immediately, exactly as archiving does, and what the bin holds onto is
   * the transcript. That's the deliberate trade — the conversation is what
   * people regret losing, while a month of held-open worktrees is real disk
   * (a checked-out tree with its node_modules) and a month of held-open
   * branches is real clutter in `git branch`. Neither is on GitHub either way:
   * session branches have no upstream and are never pushed.
   *
   * The consequence to be honest about: uncommitted work in the worktree, and
   * commits on the session branch, are gone the moment you delete — same as
   * today. Restore brings back the history, not the code.
   *
   * The live `claude` process closes and control is released. The session is
   * not resumable while it sits here.
   *
   * With `RENKI_TRASH_RETENTION_DAYS=0` the bin is switched off and this purges
   * straight away, matching the old behaviour for anyone who wants it.
   */
  async trashSession(id: string): Promise<Session | null> {
    const session = this.getSession(id);
    if (this.config.trashRetentionMs <= 0) {
      await this.purgeSession(id);
      return null;
    }
    if (session.status === "trashed") return session;

    this.closeLive(id, "trashed");
    this.clearResume(id);
    // Already archived means the workdir went at archive time.
    if (session.status !== "archived") {
      await this.cleanUpWorkdir(session).catch((err) =>
        logger.warn("workdir cleanup failed during trash", { id, err: String(err) }),
      );
    }
    this.patch(id, {
      status: "trashed",
      trashedAt: Date.now(),
      trashedFrom: session.status,
      controller: null,
      hasPendingPermission: false,
    });
    this.events.append(id, { kind: "status_changed", status: "trashed" });
    if (session.controller) this.events.append(id, { kind: "control_changed", controller: null, controllerName: null });
    this.pendingPermissions.delete(id);
    this.queues.delete(id);
    const trashed = this.getSession(id);
    logger.info("session trashed", { id, purgeAt: trashed.purgeAt });
    return trashed;
  }

  /**
   * Take a session back out of the trash — as an ARCHIVED session, always.
   *
   * Its worktree and branch went at delete time, so "idle" would be a lie: the
   * session would offer a prompt box and then fail on a working directory that
   * no longer exists. Archived is the state that honestly describes what came
   * back — a readable transcript — and it's the same state a session reaches by
   * being archived normally.
   */
  restoreSession(id: string): Session {
    const session = this.getSession(id);
    if (session.status !== "trashed") return session;

    this.patch(id, { status: "archived", trashedAt: null, trashedFrom: null });
    this.events.append(id, { kind: "status_changed", status: "archived" });
    logger.info("session restored from trash", { id, trashedFrom: this.trashedFromOf(id) });
    return this.getSession(id);
  }

  /**
   * Permanently remove a session: wipes its transcript, worktree and branch —
   * no content or history kept, not shown or resumable. Unlike an old-style
   * full delete, the DB row itself survives as a tombstone (repoId/repoName
   * plus status "deleted"), stripped of everything else, so its turn_result
   * events (which we also keep, see EventLog.deleteTranscript) keep attributing
   * to the right repo in stats forever. listSessions()/getSession() both
   * exclude "deleted" rows, so tombstones are invisible everywhere except
   * stats.
   *
   * This is what the trash sweep eventually calls, and what a client asks for
   * explicitly with `?purge=true`. There is no undo past this point.
   */
  async purgeSession(id: string): Promise<void> {
    const session = this.getSession(id);
    this.closeLive(id, "deleted");
    this.clearResume(id);
    // Archived and trashed sessions already had their worktree torn down.
    if (session.status !== "archived" && session.status !== "trashed") {
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
        resumeAt: null,
        resumeState: null,
        trashedAt: null,
        trashedFrom: null,
        updatedAt: Date.now(),
      })
      .where(eq(sessions.id, id))
      .run();
    this.pendingPermissions.delete(id);
    this.broadcast?.onSessionRemoved(id);
    logger.info("session deleted", { id });
  }

  /** Purge everything in the trash now, without waiting out the retention. */
  async emptyTrash(): Promise<number> {
    const ids = this.listSessions()
      .filter((s) => s.status === "trashed")
      .map((s) => s.id);
    for (const id of ids) await this.purgeSession(id);
    if (ids.length > 0) logger.info("trash emptied", { count: ids.length });
    return ids.length;
  }

  /**
   * Purge the trashed sessions whose retention has run out. Called on boot and
   * on a timer (see startTrashSweep) — on boot too, because a daemon that was
   * off for a month would otherwise keep everything until its next tick.
   */
  async sweepTrash(now = Date.now()): Promise<number> {
    const ids = dueForPurge(this.listSessions(), now, this.config.trashRetentionMs);
    for (const id of ids) {
      logger.info("purging session whose trash retention expired", { id });
      await this.purgeSession(id).catch((err) => logger.warn("trash purge failed", { id, err: String(err) }));
    }
    return ids.length;
  }

  /**
   * Record which model this turn runs under, and log a marker when it differs
   * from the last one.
   *
   * The first turn of a session never produces a marker: there's nothing to
   * have switched FROM, and "switched to X" as the opening line of a
   * transcript reads like something went wrong.
   */
  private recordModelChange(id: string, model: string | null, hasRunBefore: boolean): void {
    const row = this.db.select({ lastModel: sessions.lastModel }).from(sessions).where(eq(sessions.id, id)).get();
    const previous = row?.lastModel ?? null;
    if (hasRunBefore && previous !== model) {
      this.events.append(id, { kind: "model_changed", model, previousModel: previous });
      logger.info("session model changed", { id, from: previous, to: model });
    }
    if (previous !== model) this.patch(id, { lastModel: model });
  }

  /** `trashedFrom` isn't on the public Session type — it's only ever needed here. */
  private trashedFromOf(id: string): string | null {
    const row = this.db.select({ trashedFrom: sessions.trashedFrom }).from(sessions).where(eq(sessions.id, id)).get();
    return row?.trashedFrom ?? null;
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
    if (session.status === "trashed") throw new SessionError("session_trashed", "Session is in the trash.");
    if (session.controller === deviceId) return session; // already in control; no-op

    // Taking control IS activity. Without this stamp, opening an older session
    // leaves lastActivityAt hours in the past, and the idle sweep (which runs
    // every 30s) hands the lock straight back — losing it seconds after
    // claiming it, over and over.
    this.patch(id, { controller: deviceId, lastActivityAt: Date.now() });
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
   * one finishes). If a turn is running right now, the prompt is steered INTO
   * it (`LiveClaudeSession.steer`): the CLI reads it at its next tool-call
   * boundary and answers within the same turn, so "also spin up a background
   * agent for X" starts seconds later instead of after the whole task. Only
   * when the session is busy but no live turn can take the message (a spawn or
   * account switch in progress) does it fall back to the per-session FIFO
   * queue. The `resolvePermission` policy decides tool-use requests (over WS
   * this asks the controller).
   */
  async submitPrompt(input: SubmitPromptInput): Promise<void> {
    const session = this.getSession(input.sessionId);
    if (session.status === "archived") throw new SessionError("session_archived", "Session is archived.");
    if (session.status === "trashed") throw new SessionError("session_trashed", "Session is in the trash — restore it first.");
    if (session.controller !== input.deviceId)
      throw new SessionError("not_controller", "Only the controlling device can send prompts.");
    if (!input.text.trim() && !input.attachments?.length)
      throw new SessionError("invalid_request", "Prompt text or at least one attachment is required.");

    // A new message takes over from a waiting resume: whatever it asks for is
    // what the user wants next, and it hits the same limit (and schedules its
    // own wait) if the limit is still in force.
    if (session.resume) {
      this.clearResume(input.sessionId);
      this.events.append(input.sessionId, { kind: "notice", text: "Automatic resume cancelled — you sent a new message.", level: "info" });
    }

    if (session.status === "busy") {
      const live = this.live.get(input.sessionId);
      if (live && live.busy && !live.isClosed) {
        live.steer({ prompt: input.text, attachments: input.attachments, promptId: input.promptId });
        this.events.append(input.sessionId, {
          kind: "prompt_submitted",
          promptId: input.promptId,
          deviceId: input.deviceId,
          text: input.text,
          attachments: input.attachments,
          steered: true,
        });
        this.patch(input.sessionId, { lastActivityAt: Date.now() });
        return;
      }
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

    await this.runTurns(input);
  }

  /**
   * Run a turn, then everything queued behind it. Stops early when a turn
   * pauses on a usage limit: the prompts behind it would only hit the same
   * limit, so they stay queued and run after the resumed turn instead.
   */
  private async runTurns(first: SubmitPromptInput): Promise<void> {
    let next: SubmitPromptInput | undefined = first;
    while (next) {
      const { paused } = await this.runOneTurn(next);
      if (paused) return;
      next = this.queues.get(next.sessionId)?.shift();
    }
  }

  /** Runs exactly one Claude turn for an already-idle session. `paused` means it stopped on a limit and a resume is scheduled. */
  private async runOneTurn(input: SubmitPromptInput): Promise<{ paused: boolean }> {
    const session = this.getSession(input.sessionId);

    // Mark a model switch BEFORE the prompt it applies to, so the transcript
    // reads in the order it happened. Only a turn that actually starts gets
    // here — a prompt steered into a running turn can't change the model
    // mid-flight (see applyKnobs), so it never claims one.
    // `claudeSessionId` is the daemon's record that a turn has run here
    // before — it's only set once the SDK hands one back.
    this.recordModelChange(input.sessionId, input.model ?? null, session.claudeSessionId != null);

    // Flip to busy and record the prompt BEFORE any await, so a concurrent
    // submit for the same session loses the race and gets queued instead.
    this.patch(input.sessionId, { status: "busy", lastActivityAt: Date.now() });
    this.events.append(input.sessionId, { kind: "status_changed", status: "busy" });
    this.events.append(input.sessionId, {
      kind: "prompt_submitted",
      promptId: input.promptId,
      deviceId: input.deviceId,
      text: input.text,
      attachments: input.attachments,
    });

    // Instant, LLM-free placeholder — shown right away (same idea as the
    // VSCode extension's "title = your first message" before it upgrades it).
    // Only the very first prompt of a session ever sees `title === null` here.
    // An attachment-only prompt (no caption) falls back to the file's own
    // name rather than titler's generic "New session".
    if (session.title == null) {
      const placeholderSource = input.text || input.attachments?.[0]?.name || "";
      this.patch(input.sessionId, { title: derivePlaceholderTitle(placeholderSource), titleSource: "placeholder", titleGenAttempts: 0 });
    }

    this.promptedTurns.add(input.sessionId);
    let resumeId = session.claudeSessionId;
    const runOnce = () =>
      this.liveFor(input.sessionId, session.worktreePath, resumeId, input).runTurn({
        prompt: input.text,
        attachments: input.attachments,
        promptId: input.promptId,
        model: input.model,
        clientType: clientTypeFromDeviceId(input.deviceId),
        maxThinkingTokens: input.maxThinkingTokens,
        permissionMode: input.permissionMode,
        resolvePermission: input.resolvePermission,
      });

    let result = await runOnce();
    resumeId = result.claudeSessionId ?? resumeId;

    // Rate-limit auto-rotation: if the turn failed because the account hit its
    // limit, switch to the other account and retry the SAME prompt exactly once.
    // The turn has already ended, so this swap is at a clean boundary — never
    // mid-flight. Once only, so two exhausted accounts can't loop.
    if (!result.ok && result.rateLimited && this.autoSwitch?.autoRetryEnabled) {
      // Deliberately not "switching account" — the switch may turn out to be
      // impossible (every login at its limit), and promising one we don't make
      // reads as a bug.
      this.events.append(input.sessionId, { kind: "notice", text: "Usage limit hit — looking for another account…", level: "warn" });
      const sw = await this.autoSwitch.rateLimitSwitch();
      if (sw.switched) {
        this.events.append(input.sessionId, {
          kind: "notice",
          text: `Switched account${sw.active ? ` (now #${sw.active})` : ""} — retrying.`,
          level: "info",
        });
        // The running process may hold the exhausted account's credentials in
        // memory — start a fresh one that resumes the same transcript.
        this.closeLive(input.sessionId, "account switched");
        result = await runOnce();
        resumeId = result.claudeSessionId ?? resumeId;
      } else {
        // `reason` says which of the several "didn't switch" cases this was, so
        // the transcript can distinguish "all accounts spent" from "the switch
        // silently failed" — they call for opposite responses.
        this.events.append(input.sessionId, {
          kind: "notice",
          text: sw.reason ?? "No other account available to switch to.",
          level: "warn",
        });
      }
    }

    this.promptedTurns.delete(input.sessionId);
    // The session may have been archived/deleted while the turn ran (which
    // closed the process and failed the turn) — don't resurrect it as idle.
    if (this.isRetired(input.sessionId)) return { paused: false };

    // Still limited after any account switch: wait for a reset instead of
    // leaving the turn dead. Idle rather than error while it waits — the
    // failure is handled, and the session list shows the pause instead.
    const paused = !result.ok && result.rateLimited && !result.interrupted && (await this.scheduleResume(input, result));

    const nextStatus: SessionStatus = result.ok || paused ? "idle" : "error";
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
    return { paused };
  }

  // ── Resuming after a usage limit ────────────────────────────────────────────

  /**
   * Arrange for a turn that stopped on a usage limit to be continued once a
   * limit resets. Returns false when it won't be: auto-resume is off, or it has
   * already been retried MAX_RESUME_ATTEMPTS times.
   *
   * The rotator decides when (see planResume): the earliest reset across every
   * account when rotation is on, the active account's otherwise. At that
   * moment it switches to whichever account is free (prepareResume), and the
   * turn runs as if the user had sent it.
   */
  private async scheduleResume(input: SubmitPromptInput, result: RunTurnResult): Promise<boolean> {
    const auto = this.autoSwitch;
    if (!auto?.autoResumeEnabled) return false;
    const attempt = input.resumeAttempt ?? 0;
    if (attempt >= MAX_RESUME_ATTEMPTS) {
      this.events.append(input.sessionId, {
        kind: "notice",
        text: `Still limited after ${attempt} automatic attempts, so Renki has stopped retrying this turn. Send a message to continue.`,
        level: "warn",
      });
      return false;
    }

    let plan: ResumePlan;
    try {
      plan = await auto.planResume({ model: input.model ?? null, hit: result.rateLimit ?? null, attempt });
    } catch (err) {
      logger.warn("could not plan a resume", { sessionId: input.sessionId, err: String(err) });
      return false;
    }
    if (this.isRetired(input.sessionId)) return false;

    const continuation = this.turnMadeProgress(input.sessionId, input.promptId);
    const state: ResumeState = {
      reason: plan.reason,
      attempt,
      prompt: {
        deviceId: input.deviceId,
        text: continuation ? RESUME_CONTINUE_TEXT : input.text,
        attachments: continuation ? undefined : input.attachments,
        model: input.model,
        maxThinkingTokens: input.maxThinkingTokens,
        permissionMode: input.permissionMode,
      },
    };
    this.patch(input.sessionId, { resumeAt: plan.at, resumeState: JSON.stringify(state) });
    this.events.append(input.sessionId, {
      kind: "notice",
      text: `Paused on a usage limit. ${plan.reason} The turn will continue automatically then.`,
      level: "warn",
    });
    this.armResume(input.sessionId, plan.at);
    logger.info("resume scheduled", { sessionId: input.sessionId, at: new Date(plan.at).toISOString(), attempt, continuation });
    return true;
  }

  /** Did the turn answering `promptId` get anywhere (text or tool calls) before it failed? */
  private turnMadeProgress(sessionId: string, promptId: string): boolean {
    let inTurn = false;
    for (const e of this.events.read(sessionId)) {
      if (e.kind === "prompt_submitted" && e.promptId === promptId) inTurn = true;
      else if (!inTurn) continue;
      else if (e.kind === "turn_result" && e.promptId === promptId) return false;
      else if (e.kind === "tool_result") return true;
      else if (e.kind === "assistant_block" && e.blockKind !== "thinking" && !e.parentToolUseId) return true;
    }
    return false;
  }

  private armResume(sessionId: string, at: number): void {
    const existing = this.resumeTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, at - Date.now());
    const timer = setTimeout(() => {
      this.resumeTimers.delete(sessionId);
      if (at - Date.now() > 1_000) this.armResume(sessionId, at);
      else void this.runResume(sessionId, false);
    }, Math.min(delay, MAX_TIMER_STEP_MS));
    timer.unref();
    this.resumeTimers.set(sessionId, timer);
  }

  /** Drop a session's scheduled resume, if it has one. */
  private clearResume(sessionId: string): void {
    const timer = this.resumeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(sessionId);
    const row = this.db.select({ resumeAt: sessions.resumeAt }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (row?.resumeAt != null) this.patch(sessionId, { resumeAt: null, resumeState: null });
  }

  private readResume(sessionId: string): { at: number; state: ResumeState } | null {
    const row = this.db
      .select({ resumeAt: sessions.resumeAt, resumeState: sessions.resumeState })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (row?.resumeAt == null || !row.resumeState) return null;
    try {
      return { at: row.resumeAt, state: JSON.parse(row.resumeState) as ResumeState };
    } catch {
      return null;
    }
  }

  /**
   * A resume came due (or the user asked for it now). Check an account can
   * take it — switching if one can and the active one can't — then run it as
   * an ordinary turn, which reschedules itself if it hits a limit again.
   *
   * `force` is the "Continue now" button: the user may know something the
   * usage numbers don't (extra usage just bought, say), so it tries even when
   * every account still looks spent.
   */
  private async runResume(sessionId: string, force: boolean): Promise<void> {
    if (this.stopping || this.resuming.has(sessionId)) return;
    this.resuming.add(sessionId);
    try {
      await this.tryResume(sessionId, force);
    } finally {
      this.resuming.delete(sessionId);
    }
  }

  private async tryResume(sessionId: string, force: boolean): Promise<void> {
    const pending = this.readResume(sessionId);
    if (!pending) return;
    if (this.isRetired(sessionId)) return this.clearResume(sessionId);

    // Something is running (a background agent's follow-up, say): give it a minute.
    if (this.getSession(sessionId).status === "busy") return this.reschedule(sessionId, pending.state, Date.now() + 60_000, null);

    const { state } = pending;
    let ready: ResumeReadiness = { proceed: true };
    try {
      ready = (await this.autoSwitch?.prepareResume(state.prompt.model ?? null)) ?? { proceed: true };
    } catch (err) {
      logger.warn("resume readiness check failed; trying anyway", { sessionId, err: String(err) });
    }
    // The world may have moved during that await: a new prompt, a cancel, an archive.
    const current = this.readResume(sessionId);
    if (!current || current.at !== pending.at || this.isRetired(sessionId)) return;
    if (this.getSession(sessionId).status === "busy") return this.reschedule(sessionId, state, Date.now() + 60_000, null);

    if (!ready.proceed && !force) return this.reschedule(sessionId, state, ready.plan.at, ready.plan.reason);

    this.clearResume(sessionId);
    if (ready.proceed && ready.note) this.events.append(sessionId, { kind: "notice", text: ready.note, level: "info" });
    this.events.append(sessionId, {
      kind: "notice",
      text: force ? "Continuing now, as requested." : "Usage limit reset — continuing.",
      level: "info",
    });
    logger.info("running scheduled resume", { sessionId, attempt: state.attempt + 1, force });

    const resolvePermission = this.resolverFor?.(sessionId);
    if (!resolvePermission) {
      logger.error("no permission resolver wired; cannot run a resumed turn", { sessionId });
      return;
    }
    // Hand the turn off without awaiting it: it can run for many minutes, and
    // the `resuming` guard only needs to cover the check above — once the
    // session is busy, a second trigger finds nothing waiting.
    void this.runResumedTurn(sessionId, state, resolvePermission);
  }

  private async runResumedTurn(sessionId: string, state: ResumeState, resolvePermission: PermissionResolver): Promise<void> {
    try {
      await this.runTurns({
        sessionId,
        deviceId: state.prompt.deviceId,
        promptId: `resume_${randomUUID()}`,
        text: state.prompt.text,
        attachments: state.prompt.attachments,
        model: state.prompt.model,
        maxThinkingTokens: state.prompt.maxThinkingTokens,
        permissionMode: state.prompt.permissionMode,
        resolvePermission,
        resumeAttempt: state.attempt + 1,
      });
    } catch (err) {
      logger.warn("resumed turn failed to start", { sessionId, err: String(err) });
      this.events.append(sessionId, { kind: "error", message: err instanceof Error ? err.message : String(err), code: null });
    }
  }

  /** Move a waiting resume to a new time, and say so when the reason changed. */
  private reschedule(sessionId: string, state: ResumeState, at: number, reason: string | null): void {
    const next: ResumeState = reason ? { ...state, reason } : state;
    this.patch(sessionId, { resumeAt: at, resumeState: JSON.stringify(next) });
    if (reason && reason !== state.reason) {
      this.events.append(sessionId, { kind: "notice", text: `Still at the limit. ${reason}`, level: "warn" });
    }
    this.armResume(sessionId, at);
  }

  /**
   * Re-arm every resume that was waiting when the daemon last stopped. Call
   * once at boot, after the rotator and permission broker are wired in. One
   * that came due while the daemon was down runs shortly after startup, a few
   * seconds apart so a batch of them doesn't all spawn at once.
   */
  restoreScheduledResumes(): void {
    const rows = this.db.select({ id: sessions.id, resumeAt: sessions.resumeAt }).from(sessions).where(isNotNull(sessions.resumeAt)).all();
    let stagger = 0;
    for (const row of rows) {
      if (row.resumeAt == null) continue;
      if (this.isRetired(row.id)) {
        this.clearResume(row.id);
        continue;
      }
      const at = row.resumeAt > Date.now() ? row.resumeAt : Date.now() + 10_000 + stagger++ * 5_000;
      this.armResume(row.id, at);
    }
    if (rows.length > 0) logger.info("restored scheduled resumes", { count: rows.length });
  }

  /**
   * The paused banner's buttons. Allowed for the controller, or for anyone
   * while nobody holds the lock: a resume is usually acted on hours later,
   * after the idle sweep has released it, and making someone take control
   * just to cancel would be ceremony.
   */
  resumeAction(id: string, deviceId: string, action: "cancel" | "now"): void {
    const session = this.getSession(id);
    if (session.controller && session.controller !== deviceId)
      throw new SessionError("not_controller", "Another device is in control of this session.");
    if (!session.resume) throw new SessionError("no_resume", "Nothing is waiting to resume.");
    if (action === "cancel") {
      this.clearResume(id);
      this.events.append(id, { kind: "notice", text: "Automatic resume cancelled.", level: "info" });
      logger.info("resume cancelled", { id, deviceId });
      // Prompts held behind the paused turn were waiting on it, not on the
      // resume — with it gone, they're next.
      this.drainQueue(id);
      return;
    }
    if (session.status === "busy") throw new SessionError("session_busy", "A turn is already running.");
    void this.runResume(id, true);
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
    const live = this.live.get(id);
    if (!live?.busy) throw new SessionError("not_busy", "No turn is running to stop.");
    live.interrupt().catch((err) => logger.warn("interrupt failed", { id, err: String(err) }));
  }

  /**
   * Push a live permission-mode change to this session's running process, if
   * any, via the SDK's mid-session control request. Lets a controller flip
   * e.g. Manual -> Auto right after answering a pending approval, so the rest
   * of that same turn stops asking instead of only affecting the NEXT
   * `submitPrompt`. Also reaches background agents still running between
   * turns. Silently a no-op with no live process — the next turn already
   * carries the new mode itself.
   */
  setPermissionMode(id: string, deviceId: string, mode: PermissionMode): void {
    const session = this.getSession(id);
    if (session.controller !== deviceId)
      throw new SessionError("not_controller", "Only the controller can change permission mode.");
    this.live.get(id)?.setPermissionMode(mode).catch((err) => logger.warn("setPermissionMode failed", { id, err: String(err) }));
  }

  // ── Live process pool ────────────────────────────────────────────────────────

  /** How many sessions have a turn (prompted or auto) in flight right now. */
  busySessionCount(): number {
    let n = 0;
    for (const live of this.live.values()) if (live.busy) n++;
    return n;
  }

  /**
   * Wait for in-flight turns to finish before a shutdown, up to `maxMs`.
   * Killing a running turn loses the user's prompt (they see "turn failed"
   * and have to resend), so a deploy should let the current turn land first.
   * Resolves true when everything is idle, false when the deadline passed
   * with work still running (the caller then closes anyway).
   */
  async drain(maxMs: number, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (this.busySessionCount() > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    return true;
  }

  /** Tear down every live process (daemon shutdown / CLI exit). Idle sessions resume transparently on their next prompt. */
  closeAll(reason = "The daemon restarted while this turn was running — send the prompt again."): void {
    // Scheduled resumes stay on their rows and are re-armed at the next boot.
    this.stopping = true;
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    for (const id of [...this.live.keys()]) this.closeLive(id, reason);
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  /**
   * Close every live process that has nothing running — used after an account
   * switch, since a running `claude` may keep the old account's credentials in
   * memory. Busy sessions and ones with background agents are left alone; the
   * rate-limit retry path handles its own session explicitly.
   */
  recycleIdleLiveSessions(reason = "account switched"): void {
    for (const [id, live] of [...this.live]) {
      if (live.busy || live.backgroundTaskCount > 0) continue;
      this.closeLive(id, reason);
    }
  }

  /** Number of sessions currently backed by a running `claude` process (for status/diagnostics). */
  liveSessionCount(): number {
    return this.live.size;
  }

  private liveFor(sessionId: string, cwd: string, resumeSessionId: string | null, first: SubmitPromptInput): LiveClaudeSession {
    const existing = this.live.get(sessionId);
    if (existing && !existing.isClosed) return existing;

    const live = new LiveClaudeSession({
      cwd,
      resumeSessionId,
      emit: this.emitterFor(sessionId),
      model: first.model,
      permissionMode: first.permissionMode,
      maxThinkingTokens: first.maxThinkingTokens,
      forcePermissionPrompts: this.config.forcePermissionPrompts,
      enableRtk: this.config.enableRtk,
      rtkBin: this.config.rtkBin,
      // Cheap to skip once the daemon already knows this — it's static per
      // `claude` install, not per-session.
      onCapabilities: hasCapabilities() ? undefined : setCapabilities,
      onAutoTurnStart: () => {
        if (this.promptedTurns.has(sessionId) || this.isRetired(sessionId)) return;
        this.patch(sessionId, { status: "busy", lastActivityAt: Date.now() });
        this.events.append(sessionId, { kind: "status_changed", status: "busy" });
      },
      onAutoTurnEnd: (result) => {
        if (this.isRetired(sessionId)) return;
        this.patch(sessionId, { claudeSessionId: result.claudeSessionId ?? undefined, lastActivityAt: Date.now() });
        // A prompted turn is about to run (it was waiting for this auto turn to
        // finish) — it owns the status from here.
        if (this.promptedTurns.has(sessionId)) return;
        const status: SessionStatus = result.ok ? "idle" : "error";
        this.patch(sessionId, { status });
        this.events.append(sessionId, { kind: "status_changed", status });
        this.drainQueue(sessionId);
      },
      onClosed: () => {
        if (this.live.get(sessionId) === live) this.live.delete(sessionId);
      },
    });
    this.live.set(sessionId, live);
    this.ensureReaper();
    return live;
  }

  /** The runner's event sink for one session: pending-permission bookkeeping, append, and delta compaction. */
  private emitterFor(sessionId: string): (payload: EventPayload) => void {
    return (payload) => {
      if (payload.kind === "permission_request") this.trackPendingPermission(sessionId, payload.requestId, true);
      else if (payload.kind === "permission_resolved") this.trackPendingPermission(sessionId, payload.requestId, false);
      this.events.append(sessionId, payload);
      if (payload.kind === "assistant_block") this.events.compactBlock(sessionId, payload.turnId, payload.blockIndex);
    };
  }

  private closeLive(id: string, reason: string): void {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    live.close(reason);
    // Whatever session id the process last reported is the one to resume with.
    if (live.claudeSessionId && !this.isRetired(id)) this.patch(id, { claudeSessionId: live.claudeSessionId });
  }

  /** Prompts queued behind an auto turn have no submitPrompt loop to drain them — start one. */
  private drainQueue(sessionId: string): void {
    const next = this.queues.get(sessionId)?.shift();
    if (!next) return;
    this.submitPrompt(next).catch((err) => {
      logger.warn("queued prompt failed to start", { sessionId, err: String(err) });
      this.events.append(sessionId, {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        code: err instanceof SessionError ? err.code : null,
      });
    });
  }

  private ensureReaper(): void {
    if (this.reaper || this.config.liveIdleMs <= 0) return;
    // Check a few times per idle window, but never more than once a second or less than once a minute.
    const every = Math.min(60_000, Math.max(1_000, Math.floor(this.config.liveIdleMs / 4)));
    this.reaper = setInterval(() => this.reapIdleLive(), every);
    this.reaper.unref();
  }

  /** Close processes that have been silent past `liveIdleMs` with nothing pending — never one mid-turn, mid-permission, or with background agents. */
  private reapIdleLive(): void {
    const now = Date.now();
    for (const [id, live] of [...this.live]) {
      if (live.busy || live.backgroundTaskCount > 0 || this.pendingPermissions.has(id)) continue;
      if (now - live.lastActivityAt < this.config.liveIdleMs) continue;
      logger.info("closing idle live session", { id, idleMs: now - live.lastActivityAt });
      this.closeLive(id, "idle");
    }
    if (this.live.size === 0 && this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  /** True once a session is archived, trashed or deleted — nothing should flip its status back. */
  private isRetired(id: string): boolean {
    const row = this.db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, id)).get();
    return !row || row.status === "archived" || row.status === "trashed" || row.status === "deleted";
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

/**
 * Every client mints its deviceId as `${prefix}_${uuid}` (see apps/web,
 * apps/mobile, apps/vscode's config.ts) — "web"/"phone"/"vscode" — so the
 * prefix doubles as a cheap, always-available client-type tag for stats
 * without a separate field the client would have to remember to send.
 */
function clientTypeFromDeviceId(deviceId: string): string {
  const i = deviceId.indexOf("_");
  return i > 0 ? deviceId.slice(0, i) : "unknown";
}

function rowToSession(row: typeof sessions.$inferSelect, retentionMs: number): Session {
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
    trashedAt: row.trashedAt,
    purgeAt: purgeAtFor(row.trashedAt, retentionMs),
    composer: {
      model: row.composerModel,
      effortKey: row.composerEffortKey,
      permissionMode: row.composerPermissionMode,
    },
    purpose: row.purpose as SessionPurpose,
    mergeMeta: row.mergeMeta ? (JSON.parse(row.mergeMeta) as MergeConflictMeta) : null,
    resume: resumeOf(row),
  };
}

/** The public view of a waiting resume — when and why, not the prompt it will send. */
function resumeOf(row: typeof sessions.$inferSelect): Session["resume"] {
  if (row.resumeAt == null || !row.resumeState) return null;
  try {
    const state = JSON.parse(row.resumeState) as ResumeState;
    return { at: row.resumeAt, reason: state.reason, attempt: state.attempt };
  } catch {
    return null;
  }
}
