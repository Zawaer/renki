import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { AppConfig } from "./config";

/**
 * Register this device for push and hand the Expo token to the daemon, so it
 * can notify us about permission requests / turn completion while the app is
 * backgrounded. Best-effort: any failure (denied permission, no EAS projectId
 * in a bare dev build) just means no pushes — the app still works fully.
 */
export async function registerForPush(config: AppConfig): Promise<void> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const status = current.granted ? "granted" : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId || undefined;
  if (!projectId) {
    console.warn("[push] no EAS projectId configured — skipping token registration");
    return;
  }

  const expoToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await fetch(`${config.baseUrl}/devices/push-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: config.deviceId, expoToken, platform: Platform.OS }),
  }).catch((err) => console.warn("[push] register failed", err));
}
