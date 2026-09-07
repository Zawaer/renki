import type { Session } from "@crc/protocol";

/**
 * How the recycle bin's deadline is worded to the user.
 *
 * Days, never hours or minutes: retention is set in days, and "deletes in 3
 * hours" invites someone to sit and watch a countdown they can't stop. The
 * only precision that matters is "have I still got time?".
 */
export function formatPurgeCountdown(purgeAt: number | null | undefined, now = Date.now()): string | null {
  if (purgeAt == null) return null;
  const ms = purgeAt - now;
  // Past its deadline but not swept yet — the sweep runs hourly, so this is a
  // normal state to render, and it should read as gone rather than as time left.
  if (ms <= 0) return "Deleting soon";
  // Rounded UP, so a session deleted a moment ago reads as the full retention
  // ("in 30 days") rather than 29 — and deliberately no "today"/"tomorrow",
  // which would claim a precision about local midnight this doesn't have.
  const days = Math.ceil(ms / (24 * 60 * 60_000));
  if (days === 1) return "Deletes within a day";
  return `Deletes in ${days} days`;
}

/** Sessions sitting in the trash, soonest deadline first — the order a bin should be reviewed in. */
export function trashedSessions(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.status === "trashed")
    .sort((a, b) => (a.trashedAt ?? 0) - (b.trashedAt ?? 0));
}

/** Sessions to show in the main list: everything that isn't archived and isn't in the bin. */
export function activeSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.status !== "archived" && s.status !== "trashed");
}
