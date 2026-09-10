import { migrateSingleConnection, type HostsState } from "@renki/client-core";
import * as SecureStore from "expo-secure-store";
import { loadConfig } from "./config";

/**
 * The list of daemons this phone knows about, in SecureStore as one JSON
 * blob (SecureStore has no native list type). Supersedes `renki.config` (a
 * single connection) — that key is read once, on first load after this
 * shipped, to fold whatever was there into host #1 so nobody gets un-paired
 * by the upgrade.
 */
const KEY = "renki.hosts";

export async function loadHosts(): Promise<HostsState> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw) return JSON.parse(raw) as HostsState;
  } catch {
    // fall through to migration/empty
  }
  const existing = await loadConfig();
  const migrated = migrateSingleConnection(existing, "Home");
  if (migrated.hosts.length > 0) await saveHosts(migrated);
  return migrated;
}

export async function saveHosts(state: HostsState): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(state));
  } catch {
    // Keychain unavailable — the switch still applies for this app session.
  }
}
