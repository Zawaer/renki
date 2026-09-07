import type { Session, SessionStatus } from "@crc/protocol";

/**
 * The recycle bin's arithmetic, kept away from the manager so the interesting
 * parts — when something is actually destroyed, and what a restore restores —
 * are testable without a database or a git repo.
 */

/** When a session trashed at `trashedAt` becomes due for purging. Null when the bin is disabled. */
export function purgeAtFor(trashedAt: number | null, retentionMs: number): number | null {
  if (trashedAt == null || retentionMs <= 0) return null;
  return trashedAt + retentionMs;
}

/**
 * The trashed sessions whose deadline has passed, oldest first.
 *
 * A trashed session with no `trashedAt` (a hand-edited row, or one written by
 * a daemon that predates the column) is left alone rather than treated as
 * infinitely old: purging is irreversible, so an unknown deadline has to mean
 * "wait", never "destroy it now".
 */
export function dueForPurge(
  sessions: Array<Pick<Session, "id" | "status" | "trashedAt">>,
  now: number,
  retentionMs: number,
): string[] {
  if (retentionMs <= 0) return [];
  return sessions
    .filter((s) => s.status === "trashed" && s.trashedAt != null && now - s.trashedAt >= retentionMs)
    .sort((a, b) => a.trashedAt! - b.trashedAt!)
    .map((s) => s.id);
}
