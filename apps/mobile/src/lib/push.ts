import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { AppConfig } from "./config";

/**
 * Where push registration stands, for Settings to show. Registration used to
 * fail silently — on Android without Firebase configured it throws, and the
 * daemon simply never learned where to send anything — so it now says which.
 */
export type PushStatus =
  | { state: "checking" }
  | { state: "on" }
  | { state: "denied" }
  /** This build can't get a push token: no Firebase config (Android) or no EAS project. */
  | { state: "not_set_up"; detail: string }
  | { state: "error"; detail: string };

let status: PushStatus = { state: "checking" };
const listeners = new Set<(s: PushStatus) => void>();

function setStatus(next: PushStatus): void {
  status = next;
  for (const fn of listeners) fn(next);
}

export function getPushStatus(): PushStatus {
  return status;
}

export function onPushStatus(fn: (s: PushStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The channels the daemon sends to (see apps/daemon's notifier): "input" for
 * anything waiting on you — a question, an approval — loud and at the top;
 * "updates" for news that can wait, like a long turn finishing.
 */
async function createChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("input", {
    name: "Needs your input",
    description: "Questions, approvals and plans waiting on you",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 200, 120, 200],
    sound: "default",
  });
  await Notifications.setNotificationChannelAsync("updates", {
    name: "Session updates",
    description: "Long turns finishing, failures, pauses on a usage limit",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  // Kept for pushes from a daemon that predates the channels above.
  await Notifications.setNotificationChannelAsync("default", {
    name: "Other",
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/**
 * Register this device for push and hand the Expo token to the daemon, so it
 * can reach you about sessions that need you while the app is closed. Never
 * throws: the outcome lands in getPushStatus() for Settings to show.
 */
export async function registerForPush(config: AppConfig): Promise<void> {
  setStatus({ state: "checking" });
  try {
    await createChannels();

    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).status === "granted";
    if (!granted) return setStatus({ state: "denied" });

    const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId || undefined;
    if (!projectId) return setStatus({ state: "not_set_up", detail: "This build has no EAS project ID." });

    let expoToken: string;
    try {
      expoToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Android can't mint a token without Firebase; this is the usual case.
      if (/firebase|fcm|google-services/i.test(message)) {
        return setStatus({ state: "not_set_up", detail: "This build has no Firebase config (google-services.json)." });
      }
      return setStatus({ state: "error", detail: message });
    }

    const res = await fetch(`${config.baseUrl}/devices/push-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: config.deviceId, expoToken, platform: Platform.OS }),
    });
    if (!res.ok) return setStatus({ state: "error", detail: `The daemon refused the registration (${res.status}).` });
    setStatus({ state: "on" });
  } catch (err) {
    setStatus({ state: "error", detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Ask the daemon to send this device a test notification. */
export async function sendTestPush(config: AppConfig): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch(`${config.baseUrl}/devices/push-test`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: config.deviceId }),
    });
    if (res.status === 404) return { ok: false, error: "The daemon needs updating before it can send a test." };
    if (!res.ok) return { ok: false, error: `The daemon answered ${res.status}.` };
    return (await res.json()) as { ok: boolean; error: string | null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the daemon." };
  }
}
