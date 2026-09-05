import { existsSync } from "node:fs";
import type { EventPayload } from "@crc/protocol";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { LiveSessionOptions } from "../src/claude/liveSession.js";
import type { RunTurnResult } from "../src/claude/runner.js";
import { generateSessionTitle } from "../src/claude/titler.js";
import type { DB } from "../src/db/index.js";
import { sessions } from "../src/db/schema.js";
import { SessionError } from "../src/sessions/errors.js";
import { MAX_QUEUED_PROMPTS, SessionManager, TITLE_UPGRADE_ATTEMPT_CAP } from "../src/sessions/manager.js";
import { cleanupConfig, makeTestConfig, makeTestDb, makeTestRepo } from "./helpers.js";

// Auto-titling (see "auto-titling" describe block below) needs to drive a real
// happy-path turn without spawning a live `claude` process, so the live
// session (the manager's only route to the SDK) and generateSessionTitle are
// mocked at the module boundary manager.ts calls through. Every other describe
// block avoids the happy path entirely instead (forcing status "busy"
// directly), so these mocks never affect them.
const runTurn = vi.hoisted(() => vi.fn());
/** Every fake live process created so far, so tests can poke its callbacks (auto turns, close) directly. */
const liveInstances = vi.hoisted(() => [] as FakeLive[]);
type FakeLive = {
  opts: LiveSessionOptions;
  busy: boolean;
  backgroundTaskCount: number;
  isClosed: boolean;
  lastActivityAt: number;
  claudeSessionId: string | null;
  closeReasons: string[];
};
vi.mock("../src/claude/liveSession.js", () => ({
  LiveClaudeSession: class FakeLiveSession {
    busy = false;
    backgroundTaskCount = 0;
    isClosed = false;
    lastActivityAt = Date.now();
    claudeSessionId: string | null = null;
    closeReasons: string[] = [];
    constructor(public opts: LiveSessionOptions) {
      liveInstances.push(this as unknown as FakeLive);
    }
    runTurn = (args: unknown) => runTurn(args);
    interrupt = async () => {};
    setPermissionMode = async () => {};
    close = (reason = "closed") => {
      this.isClosed = true;
      this.closeReasons.push(reason);
      this.opts.onClosed?.(reason);
    };
  },
}));
vi.mock("../src/claude/titler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/claude/titler.js")>();
  return { ...actual, generateSessionTitle: vi.fn() };
});

/**
 * SessionManager is where every session invariant is enforced in one place:
 * exactly one controller, a prompt only runs for the controller when idle, and
 * every state change is mirrored into the event log. These tests use a REAL
 * temp git repo (so worktrees are genuine) and exercise the guards — but stop
 * short of the happy-path turn, which would spawn a live `claude` process.
 */

const created: Config[] = [];
afterEach(() => {
  for (const c of created.splice(0)) cleanupConfig(c);
});

function setup(): { manager: SessionManager; config: Config; db: DB; repoId: string } {
  const config = makeTestConfig();
  created.push(config);
  const { repoId } = makeTestRepo(config.reposRoot);
  const db = makeTestDb();
  return { manager: new SessionManager(config, db), config, db, repoId };
}

async function newSession(manager: SessionManager, repoId: string) {
  return manager.createSession({ repoId, baseBranch: "main" });
}

/** The event kinds recorded for a session, in order. */
function kinds(manager: SessionManager, id: string): EventPayload["kind"][] {
  return manager.events.read(id).map((e) => e.kind);
}

const noopResolve = async () => ({ decision: "allow" as const, byDeviceId: null });

describe("createSession", () => {
  it("provisions a worktree and seeds the log with birth + idle status", async () => {
    const { manager, repoId } = setup();
    const session = await newSession(manager, repoId);

    expect(session.status).toBe("idle");
    expect(session.branch).toMatch(/^crc\//);
    expect(existsSync(session.worktreePath)).toBe(true);
    expect(kinds(manager, session.id)).toEqual(["session_created", "status_changed"]);
    expect(manager.getSession(session.id).id).toBe(session.id);
    expect(manager.listSessions().map((s) => s.id)).toContain(session.id);
  });

  it("rejects an unknown repo", async () => {
    const { manager } = setup();
    await expect(manager.createSession({ repoId: "ghost", baseBranch: "main" })).rejects.toMatchObject({
      code: "repo_not_found",
    });
  });

  it("rejects a repoId with no baseBranch", async () => {
    const { manager, repoId } = setup();
    await expect(manager.createSession({ repoId })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("creates a repo-less session in a plain scratch directory when repoId is omitted", async () => {
    const { manager } = setup();
    const session = await manager.createSession({ title: "Just chatting" });

    expect(session.repoId).toBeNull();
    expect(session.baseBranch).toBeNull();
    expect(session.branch).toBeNull();
    expect(session.repoName).toBe("No repo");
    expect(existsSync(session.worktreePath)).toBe(true);
    expect(kinds(manager, session.id)).toEqual(["session_created", "status_changed"]);
  });
});

describe("createConflictResolutionSession", () => {
  it("defaults an ordinary session's purpose to normal with no merge metadata", async () => {
    const { manager, repoId } = setup();
    const session = await newSession(manager, repoId);
    expect(session.purpose).toBe("normal");
    expect(session.mergeMeta).toBeNull();
  });

  it("attaches to an existing worktree instead of creating a new one, tagged merge_conflict", async () => {
    const { manager, repoId } = setup();
    const first = await newSession(manager, repoId);

    const mergeMeta = {
      sourceBranch: "feature-x",
      targetBranch: "main",
      sourceSessionId: null,
      conflictedFiles: ["shared.txt"],
    };
    const session = await manager.createConflictResolutionSession({
      repoId,
      repoName: "demo",
      branch: first.branch!,
      worktreePath: first.worktreePath,
      mergeMeta,
      title: "Merge conflict",
    });

    expect(session.purpose).toBe("merge_conflict");
    expect(session.mergeMeta).toEqual(mergeMeta);
    // Reused the SAME worktree path passed in — no new one was provisioned.
    expect(session.worktreePath).toBe(first.worktreePath);
    expect(existsSync(session.worktreePath)).toBe(true);
    expect(kinds(manager, session.id)).toEqual(["session_created", "status_changed"]);
  });
});

describe("take / release control", () => {
  it("takeControl sets the controller and emits control_changed once", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);

    manager.takeControl(s.id, "d_phone", "Phone");
    expect(manager.getSession(s.id).controller).toBe("d_phone");

    // Idempotent: taking control again as the same device adds no new event.
    manager.takeControl(s.id, "d_phone", "Phone");
    expect(kinds(manager, s.id).filter((k) => k === "control_changed")).toHaveLength(1);
  });

  it("releaseControl by a non-holder is a no-op", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d_phone");

    manager.releaseControl(s.id, "d_someone_else");
    expect(manager.getSession(s.id).controller).toBe("d_phone");

    manager.releaseControl(s.id, "d_phone");
    expect(manager.getSession(s.id).controller).toBeNull();
    expect(kinds(manager, s.id).filter((k) => k === "control_changed")).toHaveLength(2);
  });
});

describe("submitPrompt guards (no turn spawned)", () => {
  it("refuses a non-controller with not_controller", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    // No one holds the lock, so any device is a non-controller.
    await expect(
      manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hi", resolvePermission: noopResolve }),
    ).rejects.toBeInstanceOf(SessionError);
    await expect(
      manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hi", resolvePermission: noopResolve }),
    ).rejects.toMatchObject({ code: "not_controller" });
  });

  it("refuses empty text with no attachments as invalid_request", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");
    await expect(
      manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "", resolvePermission: noopResolve }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // Whitespace-only text is just as empty.
    await expect(
      manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p2", text: "   ", resolvePermission: noopResolve }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts empty text when at least one attachment is present", async () => {
    const { manager, db, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");
    // Force busy so this only exercises the guard, not a real claude spawn.
    db.update(sessions).set({ status: "busy" }).where(eq(sessions.id, s.id)).run();
    await expect(
      manager.submitPrompt({
        sessionId: s.id,
        deviceId: "d1",
        promptId: "p1",
        text: "",
        attachments: [{ name: "a.png", mediaType: "image/png", data: "AA==" }],
        resolvePermission: noopResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it("queues a second concurrent prompt instead of rejecting it", async () => {
    const { manager, db, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");
    // Force the session into a running turn without spawning claude.
    db.update(sessions).set({ status: "busy" }).where(eq(sessions.id, s.id)).run();

    // Resolves (doesn't throw) — the prompt is held, not rejected.
    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hi", resolvePermission: noopResolve });

    expect(kinds(manager, s.id)).toContain("prompt_queued");
    const queued = manager.events.read(s.id).find((e) => e.kind === "prompt_queued");
    expect(queued).toMatchObject({ promptId: "p1", deviceId: "d1", text: "hi" });
    // Still busy — queueing doesn't touch session status or start a turn.
    expect(manager.getSession(s.id).status).toBe("busy");
  });

  it("rejects with queue_full once the per-session queue cap is hit", async () => {
    const { manager, db, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");
    db.update(sessions).set({ status: "busy" }).where(eq(sessions.id, s.id)).run();

    for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) {
      await manager.submitPrompt({
        sessionId: s.id,
        deviceId: "d1",
        promptId: `p${i}`,
        text: "hi",
        resolvePermission: noopResolve,
      });
    }

    await expect(
      manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "overflow", text: "hi", resolvePermission: noopResolve }),
    ).rejects.toMatchObject({ code: "queue_full" });
  });
});

describe("interruptSession guards (no turn spawned)", () => {
  it("refuses a non-controller with not_controller", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    expect(() => manager.interruptSession(s.id, "d_someone_else")).toThrow(SessionError);
    try {
      manager.interruptSession(s.id, "d_someone_else");
    } catch (err) {
      expect((err as SessionError).code).toBe("not_controller");
    }
  });

  it("refuses to interrupt an idle session with not_busy", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    try {
      manager.interruptSession(s.id, "d1");
      throw new Error("expected interruptSession to throw");
    } catch (err) {
      expect((err as SessionError).code).toBe("not_busy");
    }
  });
});

describe("reconcileOrphanedTurns", () => {
  it("unwedges a session left busy by a simulated crash mid-turn", async () => {
    const { manager, db, config, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    // Simulate a turn that was streaming when the process died: busy, a
    // prompt_submitted, and a block under some turnId — but no turn_result.
    db.update(sessions).set({ status: "busy", hasPendingPermission: true }).where(eq(sessions.id, s.id)).run();
    manager.events.append(s.id, { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "count to 300" });
    manager.events.append(s.id, { kind: "assistant_delta", turnId: "t1", blockIndex: 0, blockKind: "text", text: "1\n2\n" });
    manager.events.append(s.id, { kind: "permission_request", requestId: "r1", turnId: "t1", toolName: "Bash", toolInput: {} });

    // Before reconciliation, the wedge is real: Stop and a new prompt both misbehave.
    expect(() => manager.interruptSession(s.id, "d1")).toThrow(SessionError);

    // A fresh SessionManager over the same DB simulates the daemon restart.
    const restarted = new SessionManager(config, db);
    restarted.reconcileOrphanedTurns();

    const after = restarted.getSession(s.id);
    expect(after.status).toBe("error");
    expect(after.hasPendingPermission).toBe(false);

    const events = restarted.events.read(s.id);
    const turnResult = events.find((e) => e.kind === "turn_result");
    expect(turnResult).toMatchObject({ turnId: "t1", promptId: "p1", ok: false, interrupted: false });
    const permResolved = events.find((e) => e.kind === "permission_resolved");
    expect(permResolved).toMatchObject({ requestId: "r1", decision: "deny" });

    // The session is usable again: a new prompt runs instead of queuing.
    runTurn.mockResolvedValueOnce(okTurn);
    restarted.takeControl(s.id, "d1");
    await restarted.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p2", text: "hi", resolvePermission: noopResolve });
    expect(restarted.events.read(s.id).map((e) => e.kind)).not.toContain("prompt_queued");
  });

  it("fabricates a turnId when the crash happened before any block streamed", async () => {
    const { manager, db, config, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    db.update(sessions).set({ status: "busy" }).where(eq(sessions.id, s.id)).run();
    manager.events.append(s.id, { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "hi" });

    const restarted = new SessionManager(config, db);
    restarted.reconcileOrphanedTurns();

    expect(restarted.getSession(s.id).status).toBe("error");
    const turnResult = restarted.events.read(s.id).find((e) => e.kind === "turn_result");
    expect(turnResult).toMatchObject({ promptId: "p1", ok: false });
    expect((turnResult as { turnId: string }).turnId).toMatch(/^orphan-/);
  });

  it("leaves idle/archived sessions untouched", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    const before = kinds(manager, s.id);

    manager.reconcileOrphanedTurns();

    expect(kinds(manager, s.id)).toEqual(before);
    expect(manager.getSession(s.id).status).toBe("idle");
  });
});

describe("archive", () => {
  it("tears down the worktree and records archived + released control", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    await manager.archiveSession(s.id);

    const archived = manager.getSession(s.id);
    expect(archived.status).toBe("archived");
    expect(archived.controller).toBeNull();
    expect(existsSync(s.worktreePath)).toBe(false);
    expect(kinds(manager, s.id)).toContain("status_changed");
    const controlEvents = manager.events.read(s.id).filter((e) => e.kind === "control_changed");
    expect(controlEvents.at(-1)).toMatchObject({ controller: null });
  });

  it("refuses to take control of an archived session", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    await manager.archiveSession(s.id);
    expect(() => manager.takeControl(s.id, "d1")).toThrow(SessionError);
    try {
      manager.takeControl(s.id, "d1");
    } catch (err) {
      expect((err as SessionError).code).toBe("session_archived");
    }
  });
});

describe("delete", () => {
  it("hides the session everywhere but keeps its turn_result stats attributed to the repo", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.events.append(s.id, {
      kind: "turn_result",
      turnId: "t1",
      promptId: "p1",
      ok: true,
      costUsd: 1.23,
      durationMs: 1000,
      errorMessage: null,
      inputTokens: 10,
      outputTokens: 20,
    });

    await manager.deleteSession(s.id);

    expect(() => manager.getSession(s.id)).toThrow(SessionError);
    expect(manager.listSessions().map((x) => x.id)).not.toContain(s.id);
    expect(existsSync(s.worktreePath)).toBe(false);

    // Transcript (session_created/status_changed/etc) is gone, but the
    // turn_result itself survives so stats keep counting it.
    expect(kinds(manager, s.id)).toEqual(["turn_result"]);

    const stats = manager.events.statsSummary();
    const repoBucket = stats.byRepo.find((r) => r.repoId === repoId);
    expect(repoBucket?.turnCount).toBe(1);
    expect(repoBucket?.costUsd).toBeCloseTo(1.23);
  });

  it("refuses any further operation on a deleted session", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    await manager.deleteSession(s.id);
    expect(() => manager.takeControl(s.id, "d1")).toThrow(SessionError);
  });
});

/** `title`/`titleSource`/`titleGenAttempts` bookkeeping straight from the DB — titleSource/titleGenAttempts aren't on the public `Session` type. */
function titleRow(db: DB, id: string) {
  return db
    .select({ title: sessions.title, titleSource: sessions.titleSource, titleGenAttempts: sessions.titleGenAttempts })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get()!;
}

const okTurn: RunTurnResult = {
  claudeSessionId: "claude-1",
  ok: true,
  costUsd: 0,
  durationMs: 1,
  errorMessage: null,
  rateLimited: false,
  interrupted: false,
};

describe("auto-titling", () => {
  beforeEach(() => {
    runTurn.mockReset().mockResolvedValue(okTurn);
    vi.mocked(generateSessionTitle).mockReset().mockResolvedValue(null);
  });

  it("sets an instant, LLM-free placeholder from the first prompt", async () => {
    const { manager, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    await manager.submitPrompt({
      sessionId: s.id,
      deviceId: "d1",
      promptId: "p1",
      text: "fix the login bug please",
      resolvePermission: noopResolve,
    });

    // This is set before the (mocked) turn is even invoked, so it's safe to
    // assert immediately rather than waiting for the upgrade attempt below.
    expect(manager.getSession(s.id).title).toBe("fix the login bug please");
  });

  it("does not touch a title set explicitly at session creation", async () => {
    const { manager, db, repoId } = setup();
    const s = await manager.createSession({ repoId, baseBranch: "main", title: "My custom title" });
    manager.takeControl(s.id, "d1");

    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hey", resolvePermission: noopResolve });
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1));

    expect(manager.getSession(s.id).title).toBe("My custom title");
    expect(titleRow(db, s.id).titleSource).toBeNull();
    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it("keeps the placeholder and counts the attempt when the model says there isn't enough context yet", async () => {
    const { manager, db, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hey", resolvePermission: noopResolve });
    await vi.waitFor(() => expect(titleRow(db, s.id).titleGenAttempts).toBe(1));

    const row = titleRow(db, s.id);
    expect(row.title).toBe("hey");
    expect(row.titleSource).toBe("placeholder");
  });

  it("upgrades the placeholder into a generated title once the model has enough context", async () => {
    const { manager, db, repoId } = setup();
    vi.mocked(generateSessionTitle).mockResolvedValueOnce(null).mockResolvedValueOnce("Fix login bug");
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hey", resolvePermission: noopResolve });
    await vi.waitFor(() => expect(titleRow(db, s.id).titleGenAttempts).toBe(1));

    await manager.submitPrompt({
      sessionId: s.id,
      deviceId: "d1",
      promptId: "p2",
      text: "the login page 500s on submit",
      resolvePermission: noopResolve,
    });
    await vi.waitFor(() => expect(titleRow(db, s.id).titleSource).toBe("generated"));

    expect(manager.getSession(s.id).title).toBe("Fix login bug");
  });

  it("stops trying once the attempt cap is hit, leaving the placeholder in place", async () => {
    const { manager, db, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    for (let i = 0; i < TITLE_UPGRADE_ATTEMPT_CAP; i++) {
      await manager.submitPrompt({
        sessionId: s.id,
        deviceId: "d1",
        promptId: `p${i}`,
        text: "hey",
        resolvePermission: noopResolve,
      });
      // Wait for each turn's upgrade attempt to land before starting the next,
      // so mockResolvedValue(null) calls line up 1:1 with submitted prompts.
      await vi.waitFor(() => expect(titleRow(db, s.id).titleGenAttempts).toBe(i + 1));
    }
    expect(generateSessionTitle).toHaveBeenCalledTimes(TITLE_UPGRADE_ATTEMPT_CAP);

    // One more turn past the cap: the guard is a synchronous DB read before any
    // async work starts, so no attempt is made at all — safe to assert right away.
    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "extra", text: "hey", resolvePermission: noopResolve });
    expect(generateSessionTitle).toHaveBeenCalledTimes(TITLE_UPGRADE_ATTEMPT_CAP);

    const row = titleRow(db, s.id);
    expect(row.titleSource).toBe("placeholder");
    expect(row.titleGenAttempts).toBe(TITLE_UPGRADE_ATTEMPT_CAP);
  });

  it("a manual rename overwrites the placeholder and permanently takes over from the auto-titler", async () => {
    const { manager, db, repoId } = setup();
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");

    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hey", resolvePermission: noopResolve });
    await vi.waitFor(() => expect(titleRow(db, s.id).titleGenAttempts).toBe(1));

    const renamed = manager.renameSession(s.id, "My chosen title");
    expect(renamed.title).toBe("My chosen title");
    expect(titleRow(db, s.id).titleSource).toBe("manual");

    // A further turn must not touch it — the upgrade guard only fires for titleSource "placeholder".
    const attemptsBeforeRename = vi.mocked(generateSessionTitle).mock.calls.length;
    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p2", text: "hey again", resolvePermission: noopResolve });
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));

    expect(manager.getSession(s.id).title).toBe("My chosen title");
    expect(vi.mocked(generateSessionTitle).mock.calls.length).toBe(attemptsBeforeRename);
  });

  it("renameSession throws for an unknown session", () => {
    const { manager } = setup();
    expect(() => manager.renameSession("s_nope", "New title")).toThrow();
  });
});

describe("live process pool", () => {
  beforeEach(() => {
    runTurn.mockReset().mockResolvedValue(okTurn);
    vi.mocked(generateSessionTitle).mockReset().mockResolvedValue(null);
    liveInstances.length = 0;
  });

  async function prompted(manager: SessionManager, repoId: string) {
    const s = await newSession(manager, repoId);
    manager.takeControl(s.id, "d1");
    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p1", text: "hi", resolvePermission: noopResolve });
    return s;
  }

  it("reuses one live process across turns of the same session", async () => {
    const { manager, repoId } = setup();
    const s = await prompted(manager, repoId);
    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p2", text: "again", resolvePermission: noopResolve });
    expect(liveInstances).toHaveLength(1);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(manager.liveSessionCount()).toBe(1);
  });

  it("archiving closes the session's live process before tearing down the worktree", async () => {
    const { manager, repoId } = setup();
    const s = await prompted(manager, repoId);
    await manager.archiveSession(s.id);
    expect(liveInstances[0]!.closeReasons).toEqual(["archived"]);
    expect(manager.liveSessionCount()).toBe(0);
  });

  it("closeAll tears down every live process; the next prompt spawns a fresh one that resumes the transcript", async () => {
    const { manager, repoId } = setup();
    const s = await prompted(manager, repoId);
    liveInstances[0]!.claudeSessionId = "claude-abc";
    manager.closeAll("shutdown");
    expect(liveInstances[0]!.closeReasons).toEqual(["shutdown"]);
    expect(manager.getSession(s.id).claudeSessionId).toBe("claude-abc");

    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p2", text: "back", resolvePermission: noopResolve });
    expect(liveInstances).toHaveLength(2);
    expect(liveInstances[1]!.opts.resumeSessionId).toBe("claude-abc");
  });

  it("recycleIdleLiveSessions skips processes that are busy or still running background agents", async () => {
    const { manager, repoId } = setup();
    const a = await prompted(manager, repoId);
    const b = await prompted(manager, repoId);
    const c = await prompted(manager, repoId);
    const [la, lb, lc] = liveInstances as [FakeLive, FakeLive, FakeLive];
    lb.busy = true;
    lc.backgroundTaskCount = 2;

    manager.recycleIdleLiveSessions();

    expect(la.closeReasons).toEqual(["account switched"]);
    expect(lb.isClosed).toBe(false);
    expect(lc.isClosed).toBe(false);
    expect(manager.liveSessionCount()).toBe(2);
    expect([a.id, b.id, c.id]).toHaveLength(3);
  });

  it("an auto turn flips the session busy, then idle, and drains a prompt queued behind it", async () => {
    const { manager, repoId } = setup();
    const s = await prompted(manager, repoId);
    const live = liveInstances[0]!;

    live.busy = true;
    live.opts.onAutoTurnStart?.("t_auto", "auto_t_auto");
    expect(manager.getSession(s.id).status).toBe("busy");
    expect(kinds(manager, s.id).filter((k) => k === "status_changed")).toHaveLength(4); // idle, busy, idle, busy

    // A prompt sent during the auto turn is queued, not run.
    await manager.submitPrompt({ sessionId: s.id, deviceId: "d1", promptId: "p2", text: "queued", resolvePermission: noopResolve });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(kinds(manager, s.id)).toContain("prompt_queued");

    live.busy = false;
    live.opts.onAutoTurnEnd?.({ ...okTurn, claudeSessionId: "claude-xyz" });
    // The auto turn's session id is persisted synchronously, before the drained prompt's own turn overwrites it.
    expect(manager.getSession(s.id).claudeSessionId).toBe("claude-xyz");
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(manager.getSession(s.id).status).toBe("idle"));
    expect(manager.getSession(s.id).claudeSessionId).toBe(okTurn.claudeSessionId);
    const submitted = manager.events.read(s.id).filter((e) => e.kind === "prompt_submitted") as Array<{ promptId: string }>;
    expect(submitted.map((e) => e.promptId)).toEqual(["p1", "p2"]);
  });

  it("interruptSession reaches the live process only while it is busy", async () => {
    const { manager, repoId } = setup();
    const s = await prompted(manager, repoId);
    expect(() => manager.interruptSession(s.id, "d1")).toThrow(SessionError);
    liveInstances[0]!.busy = true;
    expect(() => manager.interruptSession(s.id, "d1")).not.toThrow();
  });
});
