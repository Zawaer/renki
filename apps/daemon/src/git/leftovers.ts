import { execFile } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const run = promisify(execFile);

/**
 * Checkouts left in the worktrees folder after the session that owns them is
 * archived, trashed or deleted.
 *
 * A session's own worktree goes at archive time (see removeWorktree). What
 * that misses: checkouts Claude makes itself next to it, named after the
 * session, e.g. `git worktree add /data/worktrees/<id>-about-me` to work in a
 * second repo, or `gh repo clone x/y /data/worktrees/<id>-y`. Nothing tracks
 * those, so they used to stay on disk forever. Same for a session's own
 * worktree when its teardown failed or its repo is gone.
 *
 * The rule for removing one: everything in it must already be on a remote.
 * Ignored files (build output, node_modules) don't count; anything else is
 * kept and reported, never deleted.
 */

export type SessionRef = { id: string; status: string; worktreePath: string };

export type FolderOwner =
  /** The session's own worktree (by its recorded path, or by name for a deleted session whose path was cleared). */
  | { kind: "own"; session: SessionRef }
  /** A checkout Claude made next to the session's worktree: `<sessionId>-<name>`. */
  | { kind: "extra"; session: SessionRef }
  | { kind: "orphan" };

export type WorktreeFolder = { path: string; owner: FolderOwner };

/** Statuses whose folders are done with: nothing will run in them again until an unarchive rebuilds the worktree. */
export function isFinished(status: string): boolean {
  return status === "archived" || status === "trashed" || status === "deleted";
}

/** Every folder directly in the worktrees dir, with the session it belongs to (if any). */
export function listWorktreeFolders(worktreesDir: string, sessions: SessionRef[]): WorktreeFolder[] {
  let names: string[];
  try {
    names = readdirSync(worktreesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const byPath = new Map(sessions.filter((s) => s.worktreePath).map((s) => [resolve(s.worktreePath), s]));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return names.sort().map((name) => {
    const path = resolve(worktreesDir, name);
    const own = byPath.get(path) ?? byId.get(name);
    if (own) return { path, owner: { kind: "own", session: own } };
    // Session ids are `s_` + base62, so everything before the first "-" is the id.
    const dash = name.indexOf("-");
    const extra = dash > 0 ? byId.get(name.slice(0, dash)) : undefined;
    if (extra) return { path, owner: { kind: "extra", session: extra } };
    return { path, owner: { kind: "orphan" } };
  });
}

/** The extra checkouts made next to one session's worktree. */
export function extraCheckoutsOf(worktreesDir: string, session: SessionRef): string[] {
  return listWorktreeFolders(worktreesDir, [session])
    .filter((f) => f.owner.kind === "extra")
    .map((f) => f.path);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Why removing this checkout would lose something, or null when everything
 * in it is on a remote. Anything we can't read counts as something to lose.
 */
export async function unsavedWork(path: string): Promise<string | null> {
  try {
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(top) !== realpathSync(path)) return "it isn't a git checkout of its own";
  } catch {
    return "it isn't a readable git checkout";
  }
  try {
    if (!(await git(path, ["remote"]))) return "its repo has no remote to check against";
    const changed = (await git(path, ["status", "--porcelain"])).split("\n").filter((l) => l.trim()).length;
    if (changed > 0) return `it has ${changed} uncommitted file${changed === 1 ? "" : "s"}`;
    // A worktree only holds its own HEAD; a clone of its own holds every local branch, and its stashes.
    const clone = lstatSync(resolve(path, ".git")).isDirectory();
    const commits = Number.parseInt(await git(path, ["rev-list", "--count", clone ? "--branches" : "HEAD", "--not", "--remotes"]), 10);
    if (commits > 0) return `it has ${commits} commit${commits === 1 ? "" : "s"} that ${commits === 1 ? "isn't" : "aren't"} on GitHub`;
    if (clone && (await git(path, ["stash", "list"]))) return "it has stashed changes";
    return null;
  } catch (err) {
    return `git couldn't check it (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }
}

/**
 * Remove a checkout whose work is all on a remote (call unsavedWork first). A
 * worktree is unregistered from its repo, and its branch deleted unless it
 * tracks a remote branch; a clone of its own is just deleted.
 */
export async function removeCheckout(path: string): Promise<void> {
  if (lstatSync(resolve(path, ".git")).isDirectory()) {
    rmSync(path, { recursive: true, force: true });
    logger.info("removed leftover clone", { path });
    return;
  }
  const commonDir = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  const upstream = branch ? await git(path, ["config", "--get", `branch.${branch}.merge`]).catch(() => "") : "";
  try {
    await git(commonDir, ["worktree", "remove", "--force", path]);
  } catch (err) {
    // Already checked clean, so forcing loses nothing: drop the folder, then git's record of it.
    logger.warn("worktree remove failed; deleting the folder", { path, err: String(err) });
    rmSync(path, { recursive: true, force: true });
    await git(commonDir, ["worktree", "prune"]).catch(() => {});
  }
  if (branch && !upstream) {
    await git(commonDir, ["branch", "-D", branch]).catch((err) => logger.warn("branch delete failed", { branch, err: String(err) }));
  }
  logger.info("removed leftover worktree", { path, branch, commonDir });
}

export type CleanUpOutcome = { removed: string[]; kept: { path: string; why: string }[] };

/** Remove each checkout that's safe to remove; keep (and say why) the rest. */
export async function cleanUpCheckouts(paths: string[]): Promise<CleanUpOutcome> {
  const outcome: CleanUpOutcome = { removed: [], kept: [] };
  for (const path of paths) {
    const why = await unsavedWork(path);
    if (why) {
      outcome.kept.push({ path, why });
      continue;
    }
    try {
      await removeCheckout(path);
      outcome.removed.push(path);
    } catch (err) {
      outcome.kept.push({ path, why: `removing it failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})` });
    }
  }
  return outcome;
}
