import { resolveEffortKey, resolvePermissionMode, type PermissionModeKey } from "@crc/client-core";
import * as SecureStore from "expo-secure-store";

/**
 * Last model/effort/permission-mode picked in the composer, persisted on-device
 * (SecureStore — already the store this app uses for connection config, and
 * these are just as small) so they survive an app restart instead of
 * resetting to their defaults every time. Per-device, not synced across
 * devices — mirrors apps/web/src/lib/composerPrefs.ts's localStorage version,
 * just async since SecureStore has no synchronous read.
 */
const MODE_KEY = "crc.permissionMode";
const EFFORT_KEY = "crc.effortKey";
const MODEL_KEY = "crc.model";

export async function loadPermissionMode(): Promise<PermissionModeKey> {
  return resolvePermissionMode(await SecureStore.getItemAsync(MODE_KEY));
}

export function savePermissionMode(mode: PermissionModeKey): void {
  void SecureStore.setItemAsync(MODE_KEY, mode);
}

export async function loadEffortKey(): Promise<string> {
  return resolveEffortKey(await SecureStore.getItemAsync(EFFORT_KEY));
}

export function saveEffortKey(key: string): void {
  void SecureStore.setItemAsync(EFFORT_KEY, key);
}

/** "" is a valid persisted value too — means "use the SDK's own default", same as before anything's ever been picked. */
export async function loadModel(): Promise<string> {
  return (await SecureStore.getItemAsync(MODEL_KEY)) ?? "";
}

export function saveModel(model: string): void {
  void SecureStore.setItemAsync(MODEL_KEY, model);
}
