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

/**
 * The status a restored session comes back as.
 *
 * "busy" never survives a trip through the trash: the live process was closed
 * on the way in, so a restored session that claimed to be mid-turn would sit
 * there refusing prompts forever. Anything unrecognised falls back to idle,
 * which is the safe direction — a session you can prompt.
 */
export function restoreStatus(trashedFrom: string | null): SessionStatus {
  if (trashedFrom === "archived") return "archived";
  if (trashedFrom === "error") return "error";
  return "idle";
}
