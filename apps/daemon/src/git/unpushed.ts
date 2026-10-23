import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Unpushed = { commits: number; changedFiles: number };

/**
 * What a session's working tree holds that GitHub doesn't: commits on its
 * branch that no remote-tracking ref contains, and files changed but not
 * committed. Local only (no fetch), so it's cheap enough to run after every
 * turn. A push updates the remote-tracking ref, so pushed work drops out.
 * Null when the tree can't be read (gone, not a repo), or the repo has no
 * remote at all: there's nowhere to push, so nothing is "unpushed".
 */
export async function unpushedOf(worktreePath: string): Promise<Unpushed | null> {
  try {
    const remotes = await run("git", ["remote"], { cwd: worktreePath, timeout: 15_000 });
    if (!remotes.stdout.trim()) return null;
    const [count, status] = await Promise.all([
      run("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: worktreePath, timeout: 15_000 }),
      run("git", ["status", "--porcelain"], { cwd: worktreePath, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    return {
      commits: Number.parseInt(count.stdout.trim(), 10) || 0,
      changedFiles: status.stdout.split("\n").filter((l) => l.trim()).length,
    };
  } catch {
    return null;
  }
}
