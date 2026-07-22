import type { Repo } from "@crc/protocol";
import { simpleGit } from "simple-git";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { createWorktree, removeWorktree } from "./worktrees.js";

/**
 * Automated branch merging for parallel worktree sessions. A merge is always
 * attempted in a disposable scratch worktree — never a live session's worktree,
 * never the repo's own primary checkout — so it can never collide with work in
 * progress. A clean merge is committed there and the caller fast-forwards the
 * real target branch to it; a conflicted merge is left in-progress (conflict
 * markers and all) so the same scratch worktree can be handed straight to a
 * conflict-resolution session instead of copying the diff elsewhere.
 */

export type MergeResult =
  | { ok: true; worktreePath: string; branch: string; mergeCommit: string }
  | { ok: false; worktreePath: string; branch: string; conflictedFiles: string[] };

/** Git status codes (XY, porcelain v1) that mean "still conflicted". */
const CONFLICT_STATUS = /^(UU|AA|DD|AU|UA|DU|UD) /;

export async function attemptMerge(
  config: Config,
  repo: Repo,
  targetBranch: string,
  sourceBranch: string,
  scratchSessionId: string,
): Promise<MergeResult> {
  const { worktreePath, branch } = await createWorktree(
    config,
    repo.path,
    scratchSessionId,
    targetBranch,
    `crc-merge/${scratchSessionId}`,
  );
  const git = simpleGit(worktreePath);

  // Non-zero exit here means either a real conflict or nothing to merge — the
  // `git status` check right after is what actually tells us which.
  await git.raw(["merge", "--no-commit", "--no-ff", sourceBranch]).catch(() => {});

  const status = await git.raw(["status", "--porcelain=v1"]);
  const conflictedFiles = status
    .split("\n")
    .filter((line) => CONFLICT_STATUS.test(line))
    .map((line) => line.slice(3));

  if (conflictedFiles.length > 0) {
    logger.info("merge conflict detected", { repo: repo.id, targetBranch, sourceBranch, conflictedFiles });
    return { ok: false, worktreePath, branch, conflictedFiles };
  }

  await git.raw(["commit", "--no-edit"]);
  const mergeCommit = (await git.raw(["rev-parse", "HEAD"])).trim();
  logger.info("merge succeeded", { repo: repo.id, targetBranch, sourceBranch, mergeCommit });
  return { ok: true, worktreePath, branch, mergeCommit };
}

/** Fast-forward `targetBranch` to the merge commit and discard the scratch worktree used to compute it. */
export async function finalizeCleanMerge(
  repo: Repo,
  targetBranch: string,
  scratchBranch: string,
  scratchWorktreePath: string,
  mergeCommit: string,
): Promise<void> {
  const git = simpleGit(repo.path);

  // `targetBranch` is very commonly whatever's checked out in the repo's own
  // primary working directory (e.g. `main`) — and git refuses to force-move a
  // branch's ref (via `branch -f`, or even a local `fetch`) while it's checked
  // out anywhere. So when that's the case, fast-forward it in place instead,
  // which also happens to be exactly what we want: the repo's own working
  // directory picks up the merged files immediately, like a normal `git pull
  // --ff-only`. Otherwise (nobody has `targetBranch` checked out here) a plain
  // ref move is fine.
  const currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (currentBranch === targetBranch) {
    await git.raw(["merge", "--ff-only", mergeCommit]);
  } else {
    await git.raw(["branch", "-f", targetBranch, mergeCommit]);
  }

  await removeWorktree(repo.path, scratchWorktreePath, scratchBranch);
}
