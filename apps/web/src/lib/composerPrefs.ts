import { DEFAULT_EFFORT_KEY, DEFAULT_PERMISSION_MODE, EFFORT_LEVELS, type PermissionModeKey } from "@crc/client-core";

/**
 * Last model/effort/permission-mode picked in the composer, persisted in
 * localStorage so they survive a refresh/reopen instead of resetting to
 * their defaults every time. Per-browser, not synced across devices.
 */
const MODE_KEY = "crc.permissionMode";
const EFFORT_KEY = "crc.effortKey";
const MODEL_KEY = "crc.model";

const VALID_MODES: readonly PermissionModeKey[] = ["default", "acceptEdits", "plan", "auto"];
const VALID_EFFORTS: readonly string[] = EFFORT_LEVELS.map((e) => e.key);

export function loadPermissionMode(): PermissionModeKey {
  const raw = localStorage.getItem(MODE_KEY);
  return (VALID_MODES as readonly string[]).includes(raw ?? "") ? (raw as PermissionModeKey) : DEFAULT_PERMISSION_MODE;
}

export function savePermissionMode(mode: PermissionModeKey): void {
  localStorage.setItem(MODE_KEY, mode);
}

export function loadEffortKey(): string {
  const raw = localStorage.getItem(EFFORT_KEY);
  return raw && VALID_EFFORTS.includes(raw) ? raw : DEFAULT_EFFORT_KEY;
}

export function saveEffortKey(key: string): void {
  localStorage.setItem(EFFORT_KEY, key);
}

/** "" is a valid persisted value too — means "use the SDK's own default", same as before anything's ever been picked. */
export function loadModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? "";
}

export function saveModel(model: string): void {
  localStorage.setItem(MODEL_KEY, model);
}
