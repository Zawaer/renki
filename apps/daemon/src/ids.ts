import { randomBytes, randomUUID } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62.charAt(bytes.readUInt8(i) % BASE62.length);
  return out;
}

/** Full session id — stable, unique enough for local use, safe as a directory name and URL segment. */
export function newSessionId(): string {
  return `s_${randomBase62(10)}`;
}

/** Short, human-scannable suffix for derived branch names (e.g. crc/3f9a2b). */
export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

/** Turn id — one per Claude query we run inside a session. */
export function newTurnId(): string {
  return `t_${randomUUID()}`;
}
