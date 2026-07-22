import type { Config } from "../config.js";
import type { PermissionResolver } from "../claude/runner.js";
import { attemptMerge, finalizeCleanMerge } from "../git/merge.js";
import { newSessionId } from "../ids.js";
import { findRepo } from "../repos.js";
import { SessionError } from "./errors.js";
import type { SessionManager } from "./manager.js";

/**
 * Ties `git/merge.ts` (plain-git merge attempt) to the session machinery: a
 * clean merge needs no Claude at all, and only a conflict spends a session —
 * spawned pre-loaded with the conflicted worktree, seeded with a first prompt,
 * then handed off unlocked so a human can pick it up and answer questions.
 */

export type MergeOutcome = { status: "merged" } | { status: "conflict"; conflictSessionId: string };

const MERGE_BOT_DEVICE_ID = "merge-bot";

/** The merge-bot session runs unattended, so every tool call is auto-allowed until a human takes control. */
const autoApprove: PermissionResolver = async () => ({ decision: "allow", byDeviceId: null });

export async function mergeSessionBranch(
  config: Config,
  manager: SessionManager,
  repoId: string,
  sourceBranch: string,
  targetBranch: string,
  sourceSessionId: string | null,
): Promise<MergeOutcome> {
  const repo = await findRepo(config, repoId);
  if (!repo) throw new SessionError("repo_not_found", `Unknown repo: ${repoId}`);

  const scratchId = newSessionId();
  const result = await attemptMerge(config, repo, targetBranch, sourceBranch, scratchId);

  if (result.ok) {
    await finalizeCleanMerge(repo, targetBranch, result.branch, result.worktreePath, result.mergeCommit);
    return { status: "merged" };
  }

  const session = await manager.createConflictResolutionSession({
    repoId: repo.id,
    repoName: repo.name,
    branch: result.branch,
    worktreePath: result.worktreePath,
    mergeMeta: { sourceBranch, targetBranch, sourceSessionId, conflictedFiles: result.conflictedFiles },
    title: `Merge conflict: ${sourceBranch} → ${targetBranch}`,
  });

  manager.takeControl(session.id, MERGE_BOT_DEVICE_ID, "Merge Bot");
  await manager.submitPrompt({
    sessionId: session.id,
    deviceId: MERGE_BOT_DEVICE_ID,
    promptId: `merge_${scratchId}`,
    text: seedPrompt(sourceBranch, targetBranch, result.conflictedFiles),
    resolvePermission: autoApprove,
  });
  manager.releaseControl(session.id, MERGE_BOT_DEVICE_ID);

  return { status: "conflict", conflictSessionId: session.id };
}

function seedPrompt(sourceBranch: string, targetBranch: string, conflictedFiles: string[]): string {
  return [
    `You're in the middle of merging branch "${sourceBranch}" into "${targetBranch}". git left ${conflictedFiles.length} file(s) with unresolved conflicts, still marked up with <<<<<<< / ======= / >>>>>>> right here in this worktree:`,
    ...conflictedFiles.map((f) => `  - ${f}`),
    "",
    "Read each conflicted file and work out what each side was trying to do. If the right resolution isn't obvious from the code alone — e.g. which side's rename or behavior change should win — ask me before deciding, don't guess silently.",
    "Once every file is resolved: `git add` them and `git commit` (write a real merge message) to finish the merge. If a conflict looks too risky to resolve safely, tell me instead of guessing.",
  ].join("\n");
}
