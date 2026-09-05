/**
 * The daemon names a session's branch `crc/<6 hex chars>` when the user didn't
 * pick one (apps/daemon/src/git/worktrees.ts). That name carries no meaning
 * for a human — it's a worktree handle — so clients hide it and show only
 * branches someone chose deliberately.
 */
export function isAutoBranch(branch: string | null | undefined): boolean {
  return !!branch && /^crc\/[0-9a-f]{6}$/.test(branch);
}

/** The branch worth showing to a person, or null when it's an auto-generated handle. */
export function displayBranch(branch: string | null | undefined): string | null {
  return branch && !isAutoBranch(branch) ? branch : null;
}
