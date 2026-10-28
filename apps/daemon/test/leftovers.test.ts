import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { cleanUpCheckouts, listWorktreeFolders, unsavedWork } from "../src/git/leftovers.js";
import { cleanupConfig, makeTestConfig, makeTestRepo } from "./helpers.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" }).toString().trim();

const created: Config[] = [];
afterEach(() => {
  for (const c of created.splice(0)) cleanupConfig(c);
});

/** A repo with a remote that has main, and an empty worktrees dir next to it. */
function setup() {
  const config = makeTestConfig();
  created.push(config);
  const { repoPath } = makeTestRepo(config.reposRoot);
  writeFileSync(resolve(repoPath, ".gitignore"), "build/\n");
  git(repoPath, "add", ".gitignore");
  git(repoPath, "commit", "-qm", "ignore build");
  const bare = resolve(config.dataDir, "origin.git");
  git(config.dataDir, "init", "-q", "--bare", bare);
  git(repoPath, "remote", "add", "origin", bare);
  git(repoPath, "push", "-q", "origin", "main");
  mkdirSync(config.worktreesDir, { recursive: true });
  return { config, repoPath, bare };
}

/** What Claude did by hand in a session: a second worktree of a repo, on its own branch. */
function extraWorktree(repoPath: string, path: string, branch: string): string {
  git(repoPath, "worktree", "add", "-q", "-b", branch, path, "main");
  return path;
}

describe("listWorktreeFolders", () => {
  it("tells a session's own worktree, its extra checkouts and orphans apart", () => {
    const { config } = setup();
    for (const name of ["s_aaaaaaaaaa", "s_aaaaaaaaaa-about-me", "s_bbbbbbbbbb", "s_cccccccccc-x", "idealo-agent"]) {
      mkdirSync(resolve(config.worktreesDir, name));
    }
    const sessions = [
      { id: "s_aaaaaaaaaa", status: "archived", worktreePath: resolve(config.worktreesDir, "s_aaaaaaaaaa") },
      // A purged session's row keeps its id but not its path.
      { id: "s_bbbbbbbbbb", status: "deleted", worktreePath: "" },
    ];

    const owners = listWorktreeFolders(config.worktreesDir, sessions).map((f) => [
      f.path.slice(config.worktreesDir.length + 1),
      f.owner.kind === "orphan" ? "orphan" : `${f.owner.kind}:${f.owner.session.id}`,
    ]);

    expect(owners).toEqual([
      ["idealo-agent", "orphan"],
      ["s_aaaaaaaaaa", "own:s_aaaaaaaaaa"],
      ["s_aaaaaaaaaa-about-me", "extra:s_aaaaaaaaaa"],
      ["s_bbbbbbbbbb", "own:s_bbbbbbbbbb"],
      ["s_cccccccccc-x", "orphan"],
    ]);
  });
});

describe("unsavedWork", () => {
  it("passes a worktree whose only extra files are ignored build output", async () => {
    const { config, repoPath } = setup();
    const wt = extraWorktree(repoPath, resolve(config.worktreesDir, "s_aaaaaaaaaa-demo"), "renki/extra");
    mkdirSync(resolve(wt, "build"));
    writeFileSync(resolve(wt, "build", "out.js"), "built");

    expect(await unsavedWork(wt)).toBeNull();
  });

  it("holds on to uncommitted and untracked files", async () => {
    const { config, repoPath } = setup();
    const wt = extraWorktree(repoPath, resolve(config.worktreesDir, "s_aaaaaaaaaa-demo"), "renki/extra");
    writeFileSync(resolve(wt, "notes.md"), "draft");
    writeFileSync(resolve(wt, "README.md"), "changed");

    expect(await unsavedWork(wt)).toBe("it has 2 uncommitted files");
  });

  it("holds on to a commit no remote has", async () => {
    const { config, repoPath } = setup();
    const wt = extraWorktree(repoPath, resolve(config.worktreesDir, "s_aaaaaaaaaa-demo"), "renki/extra");
    writeFileSync(resolve(wt, "a.txt"), "x");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "work");

    expect(await unsavedWork(wt)).toBe("it has 1 commit that isn't on GitHub");
  });

  it("holds on to a clone's other branches and stashes, not just its HEAD", async () => {
    const { config, bare } = setup();
    const clone = resolve(config.worktreesDir, "s_aaaaaaaaaa-clone");
    git(config.worktreesDir, "clone", "-q", bare, clone);
    expect(await unsavedWork(clone)).toBeNull();

    git(clone, "switch", "-q", "-c", "side");
    writeFileSync(resolve(clone, "a.txt"), "x");
    git(clone, "add", "a.txt");
    git(clone, "commit", "-qm", "side work");
    git(clone, "switch", "-q", "main");
    expect(await unsavedWork(clone)).toBe("it has 1 commit that isn't on GitHub");

    git(clone, "branch", "-q", "-D", "side");
    writeFileSync(resolve(clone, "README.md"), "changed");
    git(clone, "stash", "-q");
    expect(await unsavedWork(clone)).toBe("it has stashed changes");
  });

  /** The repo behind it was deleted: this folder may be the only copy left. */
  it("holds on to anything git can't read, and to plain folders", async () => {
    const { config } = setup();
    const broken = resolve(config.worktreesDir, "s_aaaaaaaaaa");
    mkdirSync(broken);
    writeFileSync(resolve(broken, ".git"), "gitdir: /nowhere/.git/worktrees/s_aaaaaaaaaa\n");
    const plain = resolve(config.worktreesDir, "notes");
    mkdirSync(plain);

    expect(await unsavedWork(broken)).toBe("it isn't a readable git checkout");
    expect(await unsavedWork(plain)).toBe("it isn't a readable git checkout");
  });

  it("holds on to a repo with no remote to compare against", async () => {
    const { config } = setup();
    const { repoPath } = makeTestRepo(config.worktreesDir, "s_aaaaaaaaaa-local");
    expect(await unsavedWork(repoPath)).toBe("its repo has no remote to check against");
  });
});

describe("cleanUpCheckouts", () => {
  it("removes a clean worktree, unregisters it and deletes its branch, and keeps a dirty one", async () => {
    const { config, repoPath } = setup();
    const clean = extraWorktree(repoPath, resolve(config.worktreesDir, "s_aaaaaaaaaa-clean"), "renki/clean");
    mkdirSync(resolve(clean, "build"));
    writeFileSync(resolve(clean, "build", "out.js"), "built");
    const dirty = extraWorktree(repoPath, resolve(config.worktreesDir, "s_aaaaaaaaaa-dirty"), "renki/dirty");
    writeFileSync(resolve(dirty, "notes.md"), "draft");

    const outcome = await cleanUpCheckouts([clean, dirty]);

    expect(outcome).toEqual({ removed: [clean], kept: [{ path: dirty, why: "it has 1 uncommitted file" }] });
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(resolve(dirty, "notes.md"))).toBe(true);
    expect(git(repoPath, "worktree", "list")).not.toContain("s_aaaaaaaaaa-clean");
    expect(git(repoPath, "branch", "--list", "renki/clean")).toBe("");
    expect(git(repoPath, "branch", "--list", "renki/dirty")).toContain("renki/dirty");
  });

  it("removes a clean clone of its own", async () => {
    const { config, bare } = setup();
    const clone = resolve(config.worktreesDir, "s_aaaaaaaaaa-clone");
    git(config.worktreesDir, "clone", "-q", bare, clone);

    expect((await cleanUpCheckouts([clone])).removed).toEqual([clone]);
    expect(existsSync(clone)).toBe(false);
  });
});
