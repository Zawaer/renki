import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { simpleGit } from "simple-git";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { shortId } from "../ids.js";

/**
 * Git worktree management — the heart of "painless parallelism per repo".
 *
 * A git worktree is a second (third, fourth...) working directory backed by the
 * SAME repository, each with its own checked-out branch and its own files on
 * disk. So two sessions on the same repo get physically separate file trees:
 * Claude editing in session A can never clobber session B's uncommitted work.
 * They share history/objects (cheap) but not working state (safe).
 *
 * Each session gets a worktree at <dataDir>/worktrees/<sessionId> on a fresh
 * branch. Killing the session removes the worktree and (optionally) the branch.
 */

export type CreatedWorktree = {
  worktreePath: string;
  branch: string;
};

export async function createWorktree(
  config: Config,
  repoPath: string,
  sessionId: string,
  baseBranch: string,
  requestedBranch?: string,
): Promise<CreatedWorktree> {
  const branch = requestedBranch?.trim() || `crc/${shortId()}`;
  const worktreePath = resolve(config.worktreesDir, sessionId);
  const git = simpleGit(repoPath);

  // `worktree add -b <branch> <path> <base>`: create <branch> from <base> and
  // check it out into a brand-new directory. Fails loudly if the branch already
  // exists or the path is occupied — which is what we want (no silent reuse).
  await git.raw(["worktree", "add", "-b", branch, worktreePath, baseBranch]);

  logger.info("created worktree", { repoPath, worktreePath, branch, baseBranch });
  return { worktreePath, branch };
}

/**
 * Tear down a session's worktree. `git worktree remove --force` drops the
 * directory even if it has uncommitted changes (a killed session is abandoning
 * its work by definition). We then prune the branch. Everything is best-effort:
 * if the worktree is already gone we still want the session archived cleanly.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  deleteBranch = true,
): Promise<void> {
  const git = simpleGit(repoPath);

  try {
    await git.raw(["worktree", "remove", "--force", worktreePath]);
  } catch (err) {
    logger.warn("worktree remove failed; forcing directory cleanup", { worktreePath, err: String(err) });
    rmSync(worktreePath, { recursive: true, force: true });
    // Clear git's registry of the now-missing worktree.
    await git.raw(["worktree", "prune"]).catch(() => {});
  }

  if (deleteBranch) {
    // -D (force) because the branch's commits may not be merged anywhere.
    await git.raw(["branch", "-D", branch]).catch((err) => {
      logger.warn("branch delete failed", { branch, err: String(err) });
    });
  }

  logger.info("removed worktree", { worktreePath, branch });
}
