import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { branchStatus, pullBranch } from "../src/git/remoteStatus.js";

/**
 * Exercises the real `git` binary against a throwaway origin + clone pair —
 * no mocking, since the whole point of these helpers is correctly reading
 * git's own fetch/rev-list/ff-only output.
 */

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

/** An origin repo with one commit, plus a clone of it (the local repo under test). */
function setup(): { originPath: string; localPath: string } {
  const originPath = mkdtempSync(join(tmpdir(), "crc-origin-"));
  dirs.push(originPath);
  execFileSync("git", ["init", "-b", "main", originPath], { stdio: "ignore" });
  writeFileSync(join(originPath, "file.txt"), "v1\n");
  git(originPath, "add", "-A");
  git(originPath, "commit", "-m", "init");

  const localPath = mkdtempSync(join(tmpdir(), "crc-local-"));
  dirs.push(localPath);
  rmSync(localPath, { recursive: true, force: true }); // clone wants to create it itself
  execFileSync("git", ["clone", originPath, localPath], { stdio: "ignore" });

  return { originPath, localPath };
}

describe("branchStatus", () => {
  it("reports up to date right after a clone", async () => {
    const { localPath } = setup();
    const status = await branchStatus(localPath, "main");
    expect(status).toEqual({ ahead: 0, behind: 0, hasRemote: true });
  });

  it("reports behind once origin gains a commit", async () => {
    const { originPath, localPath } = setup();
    writeFileSync(join(originPath, "file.txt"), "v2\n");
    git(originPath, "add", "-A");
    git(originPath, "commit", "-m", "v2");

    const status = await branchStatus(localPath, "main");
    expect(status).toEqual({ ahead: 0, behind: 1, hasRemote: true });
  });

  it("reports hasRemote:false for a branch that only exists locally", async () => {
    const { localPath } = setup();
    git(localPath, "checkout", "-b", "local-only");
    const status = await branchStatus(localPath, "local-only");
    expect(status).toEqual({ ahead: 0, behind: 0, hasRemote: false });
  });
});

describe("pullBranch", () => {
  it("fast-forwards the working tree when the branch is checked out", async () => {
    const { originPath, localPath } = setup();
    writeFileSync(join(originPath, "file.txt"), "v2\n");
    git(originPath, "add", "-A");
    git(originPath, "commit", "-m", "v2");

    await pullBranch(localPath, "main");

    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("v2\n");
    expect((await branchStatus(localPath, "main")).behind).toBe(0);
  });

  it("moves the ref without touching the working tree when a different branch is checked out", async () => {
    const { originPath, localPath } = setup();
    git(localPath, "checkout", "-b", "other");
    writeFileSync(join(originPath, "file.txt"), "v2\n");
    git(originPath, "add", "-A");
    git(originPath, "commit", "-m", "v2");

    await pullBranch(localPath, "main");

    // Working tree (on `other`) is untouched...
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("v1\n");
    // ...but `main`'s ref itself was fast-forwarded.
    const localGit = simpleGit(localPath);
    expect((await localGit.raw(["show", "main:file.txt"])).trim()).toBe("v2");
  });

  it("throws instead of merge-committing when history has diverged", async () => {
    const { originPath, localPath } = setup();
    writeFileSync(join(originPath, "file.txt"), "from origin\n");
    git(originPath, "add", "-A");
    git(originPath, "commit", "-m", "origin diverges");

    writeFileSync(join(localPath, "file.txt"), "from local\n");
    git(localPath, "add", "-A");
    git(localPath, "commit", "-m", "local diverges");

    await expect(pullBranch(localPath, "main")).rejects.toThrow();
    // Nothing was silently merged or overwritten.
    expect(readFileSync(join(localPath, "file.txt"), "utf8")).toBe("from local\n");
  });
});
