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
