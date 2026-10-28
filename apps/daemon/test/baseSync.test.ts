import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baseStatusOf, catchUpWithBase } from "../src/git/baseSync.js";

/** Real git against a throwaway origin, like remoteStatus.test.ts. */

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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An origin with one commit, and a clone on a session branch made from origin/main the way createWorktree does. */
function setup(): { originPath: string; localPath: string } {
  const originPath = mkdtempSync(join(tmpdir(), "renki-origin-"));
  dirs.push(originPath);
  execFileSync("git", ["init", "-b", "main", originPath], { stdio: "ignore" });
  writeFileSync(join(originPath, "file.txt"), "v1\n");
  writeFileSync(join(originPath, "other.txt"), "a\n");
  git(originPath, "add", "-A");
  git(originPath, "commit", "-m", "init");

  const localPath = mkdtempSync(join(tmpdir(), "renki-local-"));
  dirs.push(localPath);
  rmSync(localPath, { recursive: true, force: true });
  execFileSync("git", ["clone", originPath, localPath], { stdio: "ignore" });
  git(localPath, "checkout", "--no-track", "-b", "renki/abc", "origin/main");
  return { originPath, localPath };
}

/** Someone else pushes to main. */
function moveMain(originPath: string): void {
  writeFileSync(join(originPath, "file.txt"), "v2\n");
  git(originPath, "commit", "-am", "elsewhere");
}

describe("catchUpWithBase", () => {
  it("does nothing when the branch is current", async () => {
    const { localPath } = setup();
    expect(await catchUpWithBase(localPath, "main", "renki/abc", true)).toEqual({ kind: "current" });
  });

  it("fast-forwards a branch with nothing of its own, keeping unrelated local edits", async () => {
    const { originPath, localPath } = setup();
    moveMain(originPath);
    writeFileSync(join(localPath, "other.txt"), "mine\n");
    expect(await catchUpWithBase(localPath, "main", "renki/abc", true)).toEqual({ kind: "updated", commits: 1 });
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(localPath, "other.txt"), "utf8")).toBe("mine\n");
  });

  it("leaves a branch with its own commits alone and says how far behind it is", async () => {
    const { originPath, localPath } = setup();
    writeFileSync(join(localPath, "other.txt"), "mine\n");
    git(localPath, "commit", "-am", "own work");
    moveMain(originPath);
    expect(await catchUpWithBase(localPath, "main", "renki/abc", true)).toEqual({ kind: "behind", commits: 1, why: "diverged" });
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("v1\n");
    expect(await baseStatusOf(localPath, "main")).toEqual({ behind: 1, ahead: 1 });
  });

  it("only reports how far behind it is with auto-pull off", async () => {
    const { originPath, localPath } = setup();
    moveMain(originPath);
    expect(await catchUpWithBase(localPath, "main", "renki/abc", false)).toEqual({ kind: "behind", commits: 1, why: "off" });
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("v1\n");
  });

  it("leaves a worktree parked off its branch where it is", async () => {
    const { originPath, localPath } = setup();
    moveMain(originPath);
    git(localPath, "checkout", "--detach", "HEAD");
    expect(await catchUpWithBase(localPath, "main", "renki/abc", true)).toEqual({ kind: "elsewhere" });
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("v1\n");
  });

  it("leaves a worktree mid-merge where it is", async () => {
    const { originPath, localPath } = setup();
    moveMain(originPath);
    writeFileSync(join(localPath, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
    expect(await catchUpWithBase(localPath, "main", "renki/abc", true)).toEqual({ kind: "elsewhere" });
  });

  it("won't overwrite an uncommitted edit to a file main changed", async () => {
    const { originPath, localPath } = setup();
    moveMain(originPath);
    writeFileSync(join(localPath, "file.txt"), "editing\n");
    expect(await catchUpWithBase(localPath, "main", "renki/abc", true)).toEqual({ kind: "behind", commits: 1, why: "local_changes" });
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("editing\n");
  });
});
