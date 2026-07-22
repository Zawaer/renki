import { DEFAULT_PERMISSION_MODE, type PermissionModeKey } from "@crc/client-core";

/**
 * Last permission mode picked in the composer, persisted in localStorage so
 * it survives a refresh/reopen instead of resetting to Manual every time.
 */
const KEY = "crc.permissionMode";
const VALID: readonly PermissionModeKey[] = ["default", "acceptEdits", "plan", "auto"];

export function loadPermissionMode(): PermissionModeKey {
  const raw = localStorage.getItem(KEY);
  return (VALID as readonly string[]).includes(raw ?? "") ? (raw as PermissionModeKey) : DEFAULT_PERMISSION_MODE;
}

export function savePermissionMode(mode: PermissionModeKey): void {
  localStorage.setItem(KEY, mode);
}
