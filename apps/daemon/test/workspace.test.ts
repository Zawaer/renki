import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspacePathError,
  listWorkspaceDir,
  readWorkspaceFile,
  safePath,
  workspaceChanges,
  workspaceFileDiff,
} from "../src/git/workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

/** A repo on `main` with two files, and a session-style branch checked out on top of it. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "renki-ws-"));
  dirs.push(dir);
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "old.txt"), "gone soon\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "checkout", "-b", "renki/abc");
  return dir;
}

describe("workspaceChanges", () => {
  it("shows commits, uncommitted edits, deletions and untracked files as one list", async () => {
    const dir = repo();
    writeFileSync(join(dir, "app.ts"), "a\nb\n");
    git(dir, "add", "app.ts");
    git(dir, "commit", "-m", "add app");
    writeFileSync(join(dir, "README.md"), "# demo\nmore\n");
    unlinkSync(join(dir, "old.txt"));
    writeFileSync(join(dir, "notes.md"), "one\ntwo\nthree\n");

    const res = await workspaceChanges(dir, "main", "renki/abc");
    expect(res).toMatchObject({ available: true, base: "main", branch: "renki/abc", ahead: 1 });
    // Case-insensitive, the way a file list reads.
    expect(res.files).toEqual([
      { path: "app.ts", status: "A", added: 2, removed: 0 },
      { path: "notes.md", status: "?", added: 3, removed: 0 },
      { path: "old.txt", status: "D", added: 0, removed: 1 },
      { path: "README.md", status: "M", added: 1, removed: 0 },
    ]);
  });

  it("isn't available outside a git working tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renki-plain-"));
    dirs.push(dir);
    expect((await workspaceChanges(dir, null, null)).available).toBe(false);
  });

  it("falls back to uncommitted work when the base branch is gone", async () => {
    const dir = repo();
    writeFileSync(join(dir, "README.md"), "# changed\n");
    const res = await workspaceChanges(dir, "no-such-branch", "renki/abc");
    expect(res.files.map((f) => f.path)).toEqual(["README.md"]);
  });
});

describe("workspaceFileDiff", () => {
  it("diffs a tracked file against the base, and shows an untracked one as all additions", async () => {
    const dir = repo();
    writeFileSync(join(dir, "README.md"), "# demo\nmore\n");
    writeFileSync(join(dir, "new.md"), "hello\nworld\n");
    expect((await workspaceFileDiff(dir, "main", "README.md")).patch).toContain("+more");
    const untracked = await workspaceFileDiff(dir, "main", "new.md");
    expect(untracked.patch).toContain("@@ -0,0 +1,2 @@\n+hello\n+world");
  });
});

describe("paths from clients", () => {
  it("refuses anything outside the working tree, including through a symlink, and .git", async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "renki-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(dir, "escape"));
    await expect(safePath(dir, "../etc/passwd")).rejects.toThrow(WorkspacePathError);
    await expect(safePath(dir, "/etc/passwd")).rejects.toThrow(WorkspacePathError);
    await expect(safePath(dir, "escape/secret")).rejects.toThrow(WorkspacePathError);
    await expect(safePath(dir, ".git/config")).rejects.toThrow(WorkspacePathError);
    await expect(readWorkspaceFile(dir, "escape/secret")).rejects.toThrow(WorkspacePathError);
  });
});

describe("listWorkspaceDir / readWorkspaceFile", () => {
  it("lists directories first, leaves out .git, and reads text and binary files", async () => {
    const dir = repo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export {}\n");
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

    const root = await listWorkspaceDir(dir, "");
    expect(root.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:src", "file:logo.png", "file:old.txt", "file:README.md"]);
    expect((await listWorkspaceDir(dir, "src")).entries).toEqual([{ name: "a.ts", type: "file", size: 10 }]);

    expect(await readWorkspaceFile(dir, "README.md")).toMatchObject({ content: "# demo\n", binary: false, truncated: false });
    expect(await readWorkspaceFile(dir, "logo.png")).toMatchObject({ content: null, binary: true });
  });
});
