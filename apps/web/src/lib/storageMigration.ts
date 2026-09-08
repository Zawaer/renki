/**
 * Carry this browser's stored state across the CRC -> Renki rename.
 *
 * Every key this app owns was prefixed `crc.`; they're `renki.` now. Without
 * this, the rename would silently log the browser out — the daemon URL and
 * token live under one of those keys — and throw away every session's draft
 * and composer picks. A rename is a change of clothes, not of identity.
 *
 * Runs once, before anything reads storage (see main.tsx). Old keys are left
 * in place rather than deleted: if you roll back to a pre-rename build, it
 * still finds what it expects, and a handful of dead keys costs nothing.
 */
const OLD_PREFIX = "crc.";
const NEW_PREFIX = "renki.";
const DONE_KEY = "renki.migratedFromCrc";

export function migrateLegacyStorage(): void {
  try {
    if (localStorage.getItem(DONE_KEY) === "1") return;
    // Snapshot the key list first: writing while iterating localStorage's live
    // index would shift it under us.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(OLD_PREFIX)) keys.push(k);
    }
    for (const oldKey of keys) {
      const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
      // Never clobber a value the renamed app has already written.
      if (localStorage.getItem(newKey) !== null) continue;
      const value = localStorage.getItem(oldKey);
      if (value !== null) localStorage.setItem(newKey, value);
    }
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Private mode or a full quota: the app still works, you just re-pair.
  }
}
