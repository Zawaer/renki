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

export class SessionManager {
  readonly events: EventLog;
  private autoSwitch: RateLimitAutoSwitch | null = null;

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
    return rowToSession(row);
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
    logger.info("session archived", { id });
    return this.getSession(id);
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
   * Submit a finished prompt and run one Claude turn. Enforces the lock and the
   * single-writer invariant, then streams the turn to the event log. Returns
   * when the turn completes. The `resolvePermission` policy decides tool-use
   * requests (in Step 2 this asks the controller over WS).
   */
  async submitPrompt(input: {
    sessionId: string;
    deviceId: string;
    promptId: string;
    text: string;
    resolvePermission: PermissionResolver;
    model?: string;
    maxThinkingTokens?: number | null;
  }): Promise<void> {
    const session = this.getSession(input.sessionId);
    if (session.status === "archived") throw new SessionError("session_archived", "Session is archived.");
    if (session.controller !== input.deviceId)
      throw new SessionError("not_controller", "Only the controlling device can send prompts.");
    if (session.status === "busy")
      throw new SessionError("session_busy", "A turn is already running for this session.");

    // Flip to busy and record the prompt BEFORE any await, so a concurrent
    // submit for the same session loses the race and gets session_busy.
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
        forcePermissionPrompts: this.config.forcePermissionPrompts,
        emit: (payload) => this.events.append(input.sessionId, payload),
        resolvePermission: input.resolvePermission,
        // Cheap to skip once the daemon already knows this — it's static per
        // `claude` install, not per-session.
        onCapabilities: hasCapabilities() ? undefined : setCapabilities,
      });

    let result = await runOnce();
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
        result = await runOnce();
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

  // ── internals ────────────────────────────────────────────────────────────────

  private patch(id: string, fields: Partial<typeof sessions.$inferInsert>): void {
    this.db
      .update(sessions)
      .set({ ...fields, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
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
    controller: row.controller,
    claudeSessionId: row.claudeSessionId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
  };
}
