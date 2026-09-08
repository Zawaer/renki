import * as SecureStore from "expo-secure-store";

/**
 * Carry this device's stored state across the CRC -> Renki rename.
 *
 * Same intent as the web's version, but SecureStore can't be enumerated, so
 * the keys are named explicitly. That's why the per-session composer picks
 * (`crc.model.<sessionId>` and friends) aren't listed: their ids are unknown
 * here, and losing them costs nothing — a session with no stored pick simply
 * inherits the global one again on next open. The connection config is the
 * key that actually matters: without it the phone would be un-paired by a
 * rename, which is not a thing a rename should do.
 *
 * Old keys are left in place, so a rollback to a pre-rename build still finds
 * what it expects.
 */
const KEYS = ["config", "deviceId", "permissionMode", "effortKey", "model"];
const DONE_KEY = "renki.migratedFromCrc";

export async function migrateLegacyStorage(): Promise<void> {
  try {
    if ((await SecureStore.getItemAsync(DONE_KEY)) === "1") return;
    for (const name of KEYS) {
      const existing = await SecureStore.getItemAsync(`renki.${name}`);
      if (existing !== null) continue; // never clobber what the new app wrote
      const legacy = await SecureStore.getItemAsync(`crc.${name}`);
      if (legacy !== null) await SecureStore.setItemAsync(`renki.${name}`, legacy);
    }
    await SecureStore.setItemAsync(DONE_KEY, "1");
  } catch {
    // Keychain unavailable — the app still works, you just pair again.
  }
}
