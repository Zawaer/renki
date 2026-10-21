import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestBase } from "../src/git/worktrees.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), file);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", file);
}

/** An "origin" repo on main and a clone of it, the way a repo sits under the repos root. */
function cloned(): { origin: string; local: string } {
  const origin = mkdtempSync(join(tmpdir(), "renki-origin-"));
  const local = mkdtempSync(join(tmpdir(), "renki-local-"));
  dirs.push(origin, local);
  git(origin, "init", "-b", "main");
  commit(origin, "a");
  git(local, "clone", origin, ".");
  return { origin, local };
}

describe("latestBase", () => {
  it("branches from origin when the local branch is only behind", async () => {
    const { origin, local } = cloned();
    commit(origin, "b");
    expect(await latestBase(local, "main")).toBe("origin/main");
  });

  it("keeps the local branch when it has commits origin doesn't", async () => {
    const { origin, local } = cloned();
    commit(origin, "b");
    commit(local, "mine");
    expect(await latestBase(local, "main")).toBe("main");
  });

  it("falls back to the local branch when there's no remote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renki-noremote-"));
    dirs.push(dir);
    git(dir, "init", "-b", "main");
    commit(dir, "a");
    expect(await latestBase(dir, "main")).toBe("main");
  });
});
