import { randomUUID } from "node:crypto";

/** Full session id — stable, globally unique, safe as a directory name. */
export function newSessionId(): string {
  return `s_${randomUUID()}`;
}

/** Short, human-scannable suffix for derived branch names (e.g. crc/3f9a2b). */
export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

/** Turn id — one per Claude query we run inside a session. */
export function newTurnId(): string {
  return `t_${randomUUID()}`;
}
