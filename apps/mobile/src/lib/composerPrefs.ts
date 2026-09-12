import { resolveEffortKey, resolvePalette, resolvePermissionMode, type PaletteKey, type PermissionModeKey } from "@renki/client-core";
import * as SecureStore from "expo-secure-store";

/**
 * This DEVICE's default model / effort / permission mode: the values a NEW
 * session is created with.
 *
 * These used to be the composer's state itself, kept per session in
 * SecureStore. That made the settings a property of the phone rather than of
 * the work — a session started here opened on a laptop set to whatever that
 * laptop last used. They now live on the session, served by the daemon (see
 * SessionComposer in @renki/protocol), and what's left here is only the seed.
 * Mirrors apps/web/src/lib/composerPrefs.ts, just async since SecureStore has
 * no synchronous read.
 *
 * "Default" is simply the last pick made anywhere on this device, since
 * there's no separate settings screen for it: choosing Opus in one session
 * means the next new session starts on Opus, without touching sessions that
 * already exist.
 */
const MODE_KEY = "renki.permissionMode";
const EFFORT_KEY = "renki.effortKey";
const MODEL_KEY = "renki.model";

export type DeviceComposerDefaults = {
  /** "" means "no pick yet" — the composer fills it from capabilities. */
  model: string;
  effortKey: string;
  permissionMode: PermissionModeKey;
};

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

/** What a new session should start with, resolved against the known vocabularies. */
export async function loadDeviceDefaults(): Promise<DeviceComposerDefaults> {
  const [model, effortKey, permissionMode] = await Promise.all([read(MODEL_KEY), read(EFFORT_KEY), read(MODE_KEY)]);
  return {
    model: model ?? "",
    effortKey: resolveEffortKey(effortKey),
    permissionMode: resolvePermissionMode(permissionMode),
  };
}

/**
 * Record a pick as this device's new default, alongside the write that pins it
 * onto the session, so the next new session inherits what you were last using.
 * Fire-and-forget: a default that fails to save is not worth interrupting a
 * picker for.
 */
export function rememberDeviceDefaults(patch: {
  model?: string;
  effortKey?: string;
  permissionMode?: PermissionModeKey;
}): void {
  if (patch.model !== undefined) void SecureStore.setItemAsync(MODEL_KEY, patch.model).catch(() => {});
  if (patch.effortKey !== undefined) void SecureStore.setItemAsync(EFFORT_KEY, patch.effortKey).catch(() => {});
  if (patch.permissionMode !== undefined) void SecureStore.setItemAsync(MODE_KEY, patch.permissionMode).catch(() => {});
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
