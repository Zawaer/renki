import { resolveEffortKey, resolvePalette, resolvePermissionMode, type PaletteKey, type PermissionModeKey } from "@renki/client-core";
import * as SecureStore from "expo-secure-store";

/**
 * The model / effort / permission mode a session's composer is set to,
 * persisted on-device (SecureStore — already the store this app uses for
 * connection config, and these are just as small) so they survive an app
 * restart. Per-device, not synced; mirrors apps/web/src/lib/composerPrefs.ts,
 * just async since SecureStore has no synchronous read.
 *
 * Kept PER SESSION, for the same reason as on the web: sessions are how work
 * is separated here, and one global pick meant every switch between them
 * silently re-armed the composer with the other session's choice. A session
 * with no pick of its own inherits the last pick made anywhere.
 */
const MODE_KEY = "renki.permissionMode";
const EFFORT_KEY = "renki.effortKey";
const MODEL_KEY = "renki.model";

/** The session's own value, else the global "last used", else null. */
async function readScoped(key: string, sessionId: string | null): Promise<string | null> {
  try {
    const scoped = sessionId ? await SecureStore.getItemAsync(`${key}.${sessionId}`) : null;
    return scoped ?? (await SecureStore.getItemAsync(key));
  } catch {
    return null;
  }
}

/**
 * Fix a session's value the first time it's read, so it stops tracking picks
 * made elsewhere. Inheriting the last pick once is useful; inheriting forever
 * means choosing Haiku in one session silently changes what an untouched one
 * sends. Only the SESSION's key is written — the global stays whatever was
 * last chosen deliberately, for the next new session to inherit.
 */
async function pinScoped(key: string, sessionId: string | null, resolved: string): Promise<void> {
  if (!sessionId) return;
  try {
    const k = `${key}.${sessionId}`;
    if ((await SecureStore.getItemAsync(k)) === null) await SecureStore.setItemAsync(k, resolved);
  } catch {
    /* storage unavailable — it just won't be remembered */
  }
}

/** Writes both the session's value and the global fallback for the next new session. */
function writeScoped(key: string, sessionId: string | null, value: string): void {
  if (sessionId) void SecureStore.setItemAsync(`${key}.${sessionId}`, value).catch(() => {});
  void SecureStore.setItemAsync(key, value).catch(() => {});
}

export async function loadPermissionMode(sessionId: string | null = null): Promise<PermissionModeKey> {
  const resolved = resolvePermissionMode(await readScoped(MODE_KEY, sessionId));
  void pinScoped(MODE_KEY, sessionId, resolved);
  return resolved;
}

export function savePermissionMode(mode: PermissionModeKey, sessionId: string | null = null): void {
  writeScoped(MODE_KEY, sessionId, mode);
}

export async function loadEffortKey(sessionId: string | null = null): Promise<string> {
  const resolved = resolveEffortKey(await readScoped(EFFORT_KEY, sessionId));
  void pinScoped(EFFORT_KEY, sessionId, resolved);
  return resolved;
}

export function saveEffortKey(key: string, sessionId: string | null = null): void {
  writeScoped(EFFORT_KEY, sessionId, key);
}

/**
 * "" is a valid persisted value too — means "use the SDK's own default", same
 * as before anything's ever been picked. Deliberately NOT pinned when empty:
 * the composer fills an empty pick from capabilities, and pinning "" would
 * freeze a session onto whatever that list happened to start with.
 */
export async function loadModel(sessionId: string | null = null): Promise<string> {
  const resolved = (await readScoped(MODEL_KEY, sessionId)) ?? "";
  if (resolved) void pinScoped(MODEL_KEY, sessionId, resolved);
  return resolved;
}

export function saveModel(model: string, sessionId: string | null = null): void {
  writeScoped(MODEL_KEY, sessionId, model);
}

/**
 * The accent palette, device-wide rather than per session — it's a look, not a
 * property of the work. Stored beside the composer prefs because it's the same
 * kind of thing: a small local preference, not state the daemon owns.
 */
const PALETTE_KEY = "renki.palette";

export async function loadPalette(): Promise<PaletteKey> {
  try {
    return resolvePalette(await SecureStore.getItemAsync(PALETTE_KEY));
  } catch {
    return resolvePalette(null);
  }
}

export function savePalette(palette: PaletteKey): void {
  void SecureStore.setItemAsync(PALETTE_KEY, palette).catch(() => {});
}
