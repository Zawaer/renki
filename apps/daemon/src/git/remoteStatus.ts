import { simpleGit } from "simple-git";

/**
 * How far `branch` has diverged from `origin/<branch>`. Runs a real `git
 * fetch` first (read-only against the working tree — it only updates
 * remote-tracking refs), so this always reflects the remote's current state
 * rather than a possibly-stale local view.
 */
export async function branchStatus(
  repoPath: string,
  branch: string,
): Promise<{ ahead: number; behind: number; hasRemote: boolean }> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(["fetch", "origin", branch]);
  } catch {
    return { ahead: 0, behind: 0, hasRemote: false };
  }
  try {
    const out = await git.raw(["rev-list", "--left-right", "--count", `origin/${branch}...${branch}`]);
    const parts = out.trim().split(/\s+/).map(Number);
    return { behind: parts[0] ?? 0, ahead: parts[1] ?? 0, hasRemote: true };
  } catch {
    return { ahead: 0, behind: 0, hasRemote: false };
  }
}

/**
 * Fast-forward `branch` to match `origin/<branch>`. If `branch` is the repo's
 * currently checked-out branch, this also fast-forwards the working tree —
 * and, being `--ff-only`, throws instead of creating a merge commit if history
 * has diverged or a local edit would be overwritten, so a caller mid-edit on
 * this branch never loses work silently. Otherwise nothing here has it
 * checked out, so just moving the ref is safe.
 */
export async function pullBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.raw(["fetch", "origin", branch]);
  const current = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (current === branch) {
    await git.raw(["merge", "--ff-only", `origin/${branch}`]);
  } else {
    await git.raw(["fetch", "origin", `${branch}:${branch}`]);
  }
}
