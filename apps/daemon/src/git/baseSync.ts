import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
  /**
   * Behind, and left there: auto-update is off, or fast-forwarding would
   * lose or rewrite something (the branch has its own commits, or local
   * edits touch the incoming files).
   */
  | { kind: "behind"; commits: number; why: "off" | "diverged" | "local_changes" }
  /** Not on the session's branch, or mid merge, rebase or bisect: someone put it there on purpose, so it isn't touched. */
  | { kind: "elsewhere" };

/** What git leaves in the repo while a merge, rebase, bisect, cherry-pick or revert is under way. */
const IN_PROGRESS = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "CHERRY_PICK_HEAD", "REVERT_HEAD"];

/**
 * Before a turn: fetch `<base>`, and with `autoPull`, fast-forward the branch
 * when it's behind with nothing of its own. Sessions branch from main when
 * they start and nothing moves them after, so one that sits for a day works
 * on a stale tree while other sessions push. `--ff-only` never makes a merge
 * commit, and git refuses it rather than overwrite an uncommitted edit, so
 * this can't lose work. It only moves `branch` while it's checked out and
 * nothing is in progress: a worktree parked on an old commit, or mid rebase,
 * is that way on purpose. A failed fetch (offline) just uses what's known.
 */
export async function catchUpWithBase(worktreePath: string, baseBranch: string, branch: string, autoPull: boolean): Promise<CatchUp> {
  const current = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: worktreePath, timeout: 15_000 }).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (current !== branch || (await inProgress(worktreePath))) return { kind: "elsewhere" };
  await run("git", ["fetch", "origin", baseBranch], { cwd: worktreePath, timeout: 30_000 }).catch(() => undefined);
  const status = await baseStatusOf(worktreePath, baseBranch);
  if (!status || status.behind === 0) return { kind: "current" };
  if (!autoPull) return { kind: "behind", commits: status.behind, why: "off" };
  if (status.ahead > 0) return { kind: "behind", commits: status.behind, why: "diverged" };
  try {
    await run("git", ["merge", "--ff-only", `origin/${baseBranch}`], { cwd: worktreePath, timeout: 30_000 });
    return { kind: "updated", commits: status.behind };
  } catch {
    return { kind: "behind", commits: status.behind, why: "local_changes" };
  }
}

async function inProgress(worktreePath: string): Promise<boolean> {
  try {
    const out = await run("git", ["rev-parse", ...IN_PROGRESS.flatMap((p) => ["--git-path", p])], { cwd: worktreePath, timeout: 15_000 });
    return out.stdout
      .split("\n")
      .filter(Boolean)
      .some((p) => existsSync(resolve(worktreePath, p)));
  } catch {
    return true;
  }
}
