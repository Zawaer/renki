import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionError } from "../src/sessions/errors.js";
import { mergeSessionBranch } from "../src/sessions/mergeFlow.js";
import { SessionManager } from "../src/sessions/manager.js";
import { cleanupConfig, makeTestConfig, makeTestDb, makeTestRepo } from "./helpers.js";

/**
 * Uses a REAL SessionManager (backed by a real in-memory DB) and a real git
 * repo — same fixtures as git-merge.test.ts, which already covers
 * attemptMerge's git mechanics in isolation — so these tests focus on
 * mergeSessionBranch's ORCHESTRATION: does it correctly wire a conflict into
 * a real conflict-resolution session (control taken, prompt submitted,
 * control released), using the manager's own real validation (e.g.
 * submitPrompt's controller check) rather than a hand-rolled fake that could
 * silently accept a wrong call. `submitPrompt` itself is mocked, since a real
 * one would try to run an actual Claude turn.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function setup() {
  const config = makeTestConfig();
  cleanups.push(() => cleanupConfig(config));
  const db = makeTestDb();
  const manager = new SessionManager(config, db);
  const { repoId, repoPath } = makeTestRepo(config.reposRoot, "demo");
  return { config, manager, repoId, repoPath };
}

describe("mergeSessionBranch", () => {
  it("throws repo_not_found for an unknown repo", async () => {
    const { config, manager } = setup();
    await expect(mergeSessionBranch(config, manager, "no-such-repo", "feature", "main", null)).rejects.toThrow(SessionError);
    await expect(mergeSessionBranch(config, manager, "no-such-repo", "feature", "main", null)).rejects.toMatchObject({
      code: "repo_not_found",
    });
  });

  it("merges cleanly with no conflict-resolution session created", async () => {
    const { config, manager, repoId, repoPath } = setup();
    git(repoPath, "checkout", "-b", "feature-b");
    writeFileSync(join(repoPath, "b.txt"), "b\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "add b");
    git(repoPath, "checkout", "main");

    const submitSpy = vi.spyOn(manager, "submitPrompt");
    const before = manager.listSessions().length;

    const result = await mergeSessionBranch(config, manager, repoId, "feature-b", "main", null);

    expect(result).toEqual({ status: "merged" });
    expect(manager.listSessions()).toHaveLength(before); // no conflict session materialized
    expect(submitSpy).not.toHaveBeenCalled();

    const mainGit = simpleGit(repoPath);
    expect((await mainGit.raw(["show", "main:b.txt"])).trim()).toBe("b");
  });

  it("on conflict, creates a conflict-resolution session, takes control, seeds a prompt, then releases control", async () => {
    const { config, manager, repoId, repoPath } = setup();

    git(repoPath, "checkout", "-b", "feature-a");
    writeFileSync(join(repoPath, "shared.txt"), "from a\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "a edits shared.txt");
    git(repoPath, "checkout", "main");
    git(repoPath, "checkout", "-b", "feature-b");
    writeFileSync(join(repoPath, "shared.txt"), "from b\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "b edits shared.txt");
    git(repoPath, "checkout", "main");
    git(repoPath, "merge", "feature-a");

    // A real submitPrompt would try to run an actual Claude turn — mock it,
    // but capture the controller *at the moment it's called* (a side-channel
    // check that mergeSessionBranch really did takeControl before this, not
    // just eventually).
    let controllerDuringSubmit: string | null | undefined;
    const submitSpy = vi.spyOn(manager, "submitPrompt").mockImplementation(async (input) => {
      controllerDuringSubmit = manager.getSession(input.sessionId).controller;
    });

    const result = await mergeSessionBranch(config, manager, repoId, "feature-b", "main", "s_source123");

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") throw new Error("expected a conflict");

    const session = manager.getSession(result.conflictSessionId);
    expect(session.repoId).toBe(repoId);
    expect(session.title).toBe("Merge conflict: feature-b → main");
    expect(session.mergeMeta).toEqual({
      sourceBranch: "feature-b",
      targetBranch: "main",
      sourceSessionId: "s_source123",
      conflictedFiles: ["shared.txt"],
    });

    // Control was held (by the merge bot) during the prompt, then released —
    // "handed off unlocked so a human can pick it up", per the module doc.
    expect(controllerDuringSubmit).toBe("merge-bot");
    expect(session.controller).toBeNull();

    expect(submitSpy).toHaveBeenCalledOnce();
    const call = submitSpy.mock.calls[0]![0];
    expect(call.deviceId).toBe("merge-bot");
    expect(call.sessionId).toBe(result.conflictSessionId);
    expect(call.text).toContain("shared.txt");
    expect(call.text).toContain("feature-b");
    expect(call.text).toContain("main");

    // The seeded prompt's permission resolver auto-allows everything — the
    // merge bot runs unattended, nothing should block on a human being there.
    const decision = await call.resolvePermission?.({
      requestId: "r1",
      turnId: "t1",
      toolName: "Bash",
      toolInput: {},
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ decision: "allow", byDeviceId: null });
  });

  it("passes null sourceSessionId through untouched when there wasn't one (e.g. a manually-triggered merge)", async () => {
    const { config, manager, repoId, repoPath } = setup();
    git(repoPath, "checkout", "-b", "feature-a");
    writeFileSync(join(repoPath, "shared.txt"), "from a\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "a");
    git(repoPath, "checkout", "main");
    git(repoPath, "checkout", "-b", "feature-b");
    writeFileSync(join(repoPath, "shared.txt"), "from b\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "b");
    git(repoPath, "checkout", "main");
    git(repoPath, "merge", "feature-a");

    vi.spyOn(manager, "submitPrompt").mockResolvedValue(undefined);
    const result = await mergeSessionBranch(config, manager, repoId, "feature-b", "main", null);
    if (result.status !== "conflict") throw new Error("expected a conflict");

    expect(manager.getSession(result.conflictSessionId).mergeMeta?.sourceSessionId).toBeNull();
  });
});
