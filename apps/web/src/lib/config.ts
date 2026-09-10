/**
 * Connection config, persisted in localStorage. The deviceId is generated once
 * and kept forever on this browser — that's the identity the take-control lock
 * is tied to, so reconnecting from the same browser reclaims control.
 */
export type AppConfig = {
  baseUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  /**
   * Which stored host (see lib/hosts.ts) this config came from, so a
   * component that edits the connection (renaming this device, switching to a
   * Tailscale-detected URL) knows which host record to persist the change
   * back to. Absent for a VS Code-injected config, which isn't part of the
   * host list — that connection is owned by the workspace's own settings.
   */
  hostId?: string;
};

const KEY = "renki.config";

export function loadConfig(): AppConfig | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    if (!parsed.baseUrl || !parsed.token || !parsed.deviceId) return null;
    return { deviceName: "Web", ...parsed } as AppConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  localStorage.removeItem(KEY);
}

/** A stable per-browser device id, minted on first use. */
export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem("renki.deviceId");
  if (existing) return existing;
  const id = `web_${crypto.randomUUID()}`;
  localStorage.setItem("renki.deviceId", id);
  return id;
}
