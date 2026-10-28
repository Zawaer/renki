import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type BaseStatus = {
  /** Commits on origin/<base> this branch doesn't have. */
  behind: number;
  /** Commits on this branch origin/<base> doesn't have. */
  ahead: number;
};

/**
 * Where a session's branch stands against `origin/<base>`, as of the last
 * fetch. Local only, so it's cheap after every turn. All of a repo's
 * worktrees share remote-tracking refs, so one session's fetch or push
 * updates the picture for its siblings too. Null when it can't be read (no
 * remote, base never fetched, tree gone).
 */
export async function baseStatusOf(worktreePath: string, baseBranch: string): Promise<BaseStatus | null> {
  try {
    const out = await run("git", ["rev-list", "--left-right", "--count", `origin/${baseBranch}...HEAD`], { cwd: worktreePath, timeout: 15_000 });
    const [behind, ahead] = out.stdout.trim().split(/\s+/).map(Number);
    return { behind: behind ?? 0, ahead: ahead ?? 0 };
  } catch {
    return null;
  }
}

export type CatchUp =
  | { kind: "current" }
  | { kind: "updated"; commits: number }
  /** Behind, but fast-forwarding would lose or rewrite something: the branch has its own commits, or local edits touch the incoming files. */
  | { kind: "behind"; commits: number; why: "diverged" | "local_changes" };

/**
 * Before a turn: fetch `<base>`, and if the branch is behind it with nothing
 * of its own, fast-forward it. Sessions branch from main when they start and
 * nothing moves them after, so one that sits for a day works on a stale
 * tree while other sessions push. `--ff-only` never makes a merge commit,
 * and git refuses it rather than overwrite an uncommitted edit, so this
 * can't lose work. A failed fetch (offline) just uses what's known.
 */
export async function catchUpWithBase(worktreePath: string, baseBranch: string): Promise<CatchUp> {
  await run("git", ["fetch", "origin", baseBranch], { cwd: worktreePath, timeout: 30_000 }).catch(() => undefined);
  const status = await baseStatusOf(worktreePath, baseBranch);
  if (!status || status.behind === 0) return { kind: "current" };
  if (status.ahead > 0) return { kind: "behind", commits: status.behind, why: "diverged" };
  try {
    await run("git", ["merge", "--ff-only", `origin/${baseBranch}`], { cwd: worktreePath, timeout: 30_000 });
    return { kind: "updated", commits: status.behind };
  } catch {
    return { kind: "behind", commits: status.behind, why: "local_changes" };
  }
}
