import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "@crc/protocol";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { attemptMerge, finalizeCleanMerge } from "../src/git/merge.js";
import { newSessionId } from "../src/ids.js";
import { cleanupConfig, makeTestConfig, makeTestRepo } from "./helpers.js";

/**
 * These exercise the real `git` binary against throwaway temp repos — no
 * mocking — since the whole point of `attemptMerge` is correctly reading
 * git's own conflict-detection output.
 */

const created: Config[] = [];
afterEach(() => {
  for (const c of created.splice(0)) cleanupConfig(c);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function setup(): { config: Config; repo: Repo; repoPath: string } {
  const config = makeTestConfig();
  created.push(config);
  const { repoId, repoPath } = makeTestRepo(config.reposRoot);
  return { config, repo: { id: repoId, name: repoId, path: repoPath, defaultBranch: "main" }, repoPath };
}

describe("attemptMerge", () => {
  it("merges cleanly when the branches touch different files", async () => {
    const { config, repo, repoPath } = setup();

    git(repoPath, "checkout", "-b", "feature-b");
    writeFileSync(join(repoPath, "b.txt"), "b\n");
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-m", "add b");
    git(repoPath, "checkout", "main");

    const result = await attemptMerge(config, repo, "main", "feature-b", newSessionId());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a clean merge");

    await finalizeCleanMerge(repo, "main", result.branch, result.worktreePath, result.mergeCommit);

    const mainGit = simpleGit(repoPath);
    expect((await mainGit.raw(["rev-parse", "main"])).trim()).toBe(result.mergeCommit);
    expect((await mainGit.raw(["show", "main:b.txt"])).trim()).toBe("b");
    // Scratch worktree/branch are cleaned up, not left behind.
    expect((await mainGit.raw(["worktree", "list"])).trim().split("\n")).toHaveLength(1);
    await expect(mainGit.raw(["rev-parse", "--verify", result.branch])).rejects.toThrow();
  });

  it("detects a conflict and leaves the scratch worktree with markers in place, unmerged", async () => {
    const { config, repo, repoPath } = setup();

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

    const result = await attemptMerge(config, repo, "main", "feature-b", newSessionId());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a conflict");

    expect(result.conflictedFiles).toEqual(["shared.txt"]);

    const conflictedContent = readFileSync(join(result.worktreePath, "shared.txt"), "utf8");
    expect(conflictedContent).toContain("<<<<<<<");
    expect(conflictedContent).toContain(">>>>>>>");

    // main is untouched — nothing was merged into it.
    const mainGit = simpleGit(repoPath);
    expect((await mainGit.raw(["show", "main:shared.txt"])).trim()).toBe("from a");
  });
});
