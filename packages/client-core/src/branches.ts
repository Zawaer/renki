/**
 * The daemon names a session's branch `renki/<6 hex chars>` when the user
 * didn't pick one (apps/daemon/src/git/worktrees.ts). That name carries no
 * meaning for a human — it's a worktree handle — so clients hide it and show
 * only branches someone chose deliberately.
 *
 * `crc/` is the same handle under the project's old name. Sessions created
 * before the rename still carry it in the database, and they'd suddenly start
 * displaying a meaningless branch name if this only knew the new prefix.
 */
export function isAutoBranch(branch: string | null | undefined): boolean {
  return !!branch && /^(renki|crc)\/[0-9a-f]{6}$/.test(branch);
}

/** The branch worth showing to a person, or null when it's an auto-generated handle. */
export function displayBranch(branch: string | null | undefined): string | null {
  return branch && !isAutoBranch(branch) ? branch : null;
}
