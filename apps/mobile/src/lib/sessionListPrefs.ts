import * as SecureStore from "expo-secure-store";

/**
 * Which repo groups on the session list are folded, kept on this device like
 * the composer prefs beside it. Mirrors the web sidebar's `renki.sidebar.collapsed`.
 */
const COLLAPSED_KEY = "renki.sessionList.collapsed";

export async function loadCollapsedGroups(): Promise<Set<string>> {
  try {
    const raw = await SecureStore.getItemAsync(COLLAPSED_KEY);
    const keys: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** Fire-and-forget: a fold that fails to save just won't survive a restart. */
export function saveCollapsedGroups(keys: Set<string>): void {
  void SecureStore.setItemAsync(COLLAPSED_KEY, JSON.stringify([...keys])).catch(() => {});
}
