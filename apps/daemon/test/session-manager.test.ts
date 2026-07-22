import { existsSync } from "node:fs";
import type { EventPayload } from "@crc/protocol";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { DB } from "../src/db/index.js";
import { sessions } from "../src/db/schema.js";
import { SessionError } from "../src/sessions/errors.js";
import { MAX_QUEUED_PROMPTS, SessionManager } from "../src/sessions/manager.js";
import { cleanupConfig, makeTestConfig, makeTestDb, makeTestRepo } from "./helpers.js";

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
