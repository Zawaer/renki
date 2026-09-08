import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";

/**
 * Connection config, persisted in the device keychain via SecureStore (the
 * token is a secret). The deviceId is minted once and kept, so this phone keeps
 * the same identity for the take-control lock across restarts and reconnects.
 */
export type AppConfig = {
  baseUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
};

const CONFIG_KEY = "renki.config";
const DEVICE_KEY = "renki.deviceId";

export async function loadConfig(): Promise<AppConfig | null> {
  const raw = await SecureStore.getItemAsync(CONFIG_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<AppConfig>;
    if (!c.baseUrl || !c.token || !c.deviceId) return null;
    return { deviceName: "Phone", ...c } as AppConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config));
}

export async function clearConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(CONFIG_KEY);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY);
  if (existing) return existing;
  const id = `phone_${randomUUID()}`;
  await SecureStore.setItemAsync(DEVICE_KEY, id);
  return id;
}
