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

/** One repo's sessions in a session list. The repo IS the folder — see groupByRepo. */
export type SessionGroup = {
  /** Stable key for collapse state: the repoId, or "__none" for repo-less chats. */
  key: string;
  repoId: string | null;
  name: string;
  sessions: Session[];
  lastActivityAt: number;
  /** Counts rolled up so a COLLAPSED group can still show that something inside needs attention. */
  busy: number;
  pending: number;
};

/**
 * Group sessions by repo, most recently active first, with each group's
 * sessions in the same order.
 *
 * Shared by web and mobile: the grouping is part of how CRC reads, not a
 * per-client layout choice, and the two had drifted (mobile showed one flat
 * list) which made the same fleet look like a different product on a phone.
 */
export function groupByRepo(sessions: Session[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const key = s.repoId ?? "__none";
    let g = map.get(key);
    if (!g) {
      g = { key, repoId: s.repoId, name: s.repoId ? s.repoName : "No repo", sessions: [], lastActivityAt: 0, busy: 0, pending: 0 };
      map.set(key, g);
    }
    g.sessions.push(s);
    g.lastActivityAt = Math.max(g.lastActivityAt, s.lastActivityAt);
    if (s.status === "busy") g.busy++;
    if (s.hasPendingPermission) g.pending++;
  }
  for (const g of map.values()) g.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return [...map.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
