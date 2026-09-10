import { migrateSingleConnection, type HostsState } from "@renki/client-core";
import { loadConfig } from "./config.js";

/**
 * The list of daemons this browser knows about, in localStorage. Supersedes
 * `renki.config` (a single connection) — that key is read once, on first
 * load after this shipped, to fold whatever was there into host #1 so nobody
 * gets logged out by the upgrade.
 */
const KEY = "renki.hosts";

export function loadHosts(): HostsState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as HostsState;
  } catch {
    // fall through to migration/empty
  }
  const migrated = migrateSingleConnection(loadConfig(), "Home");
  if (migrated.hosts.length > 0) saveHosts(migrated);
  return migrated;
}

export function saveHosts(state: HostsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — the switch still applies for this tab session.
  }
}
