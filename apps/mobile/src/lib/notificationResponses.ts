import * as SecureStore from "expo-secure-store";
import type * as Notifications from "expo-notifications";

/**
 * Which notification taps have been acted on, so each is acted on exactly once: not twice when it
 * reaches both the launch check and the listener, not again when Main remounts (a host switch), and
 * not again on a later launch that replays it.
 *
 * Why this replaced "only a tap from the last 60 seconds": that check measured from when the push
 * was *sent* (expo-notifications sets a notification's date to the FCM sent time, or to
 * google.sent_time when the system tray drew it), not from the tap. So a tap that cold-started the
 * app more than a minute after the notification arrived (the usual case for an approval read a few
 * minutes later, after Android had closed the app) was silently dropped, and the app just opened on
 * the session list. A replay is what the window was guarding against: Android reopening the app from
 * Recents hands it the intent it was first launched with, notification and all. Remembering the
 * taps already handled guards against that without a clock.
 *
 * Kept in SecureStore like the rest of the app's small state: the last few keys, nothing secret.
 */
const KEY = "renki.handledNotificationResponses";
const KEEP = 30;
/** A tap older than this is never acted on, even if the list above was lost: a last line against a stale replay. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const handled: string[] = [];
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(list)) for (const k of list) if (typeof k === "string" && !handled.includes(k)) handled.push(k);
    })
    .catch(() => {});
  return loaded;
}

/** When a notification was sent, in ms (iOS has reported seconds), or null when it doesn't say. */
function sentAt(res: Notifications.NotificationResponse): number | null {
  const date = res.notification.date;
  if (typeof date !== "number" || !Number.isFinite(date) || date <= 0) return null;
  return date < 1e12 ? date * 1000 : date;
}

/**
 * True the first time a given tap (its notification and which button) comes through, false after.
 * Safe to call twice at once for the same tap: after the load, the check and the claim run without
 * a break, so only one of them wins.
 */
export async function claimNotificationResponse(res: Notifications.NotificationResponse): Promise<boolean> {
  await load();
  // A tap the system tray drew carries google.message_id as its identifier; should that ever be
  // missing, fall back to what the push said and when, so two different taps never share a key.
  const id = res.notification.request.identifier || `${res.notification.date}:${JSON.stringify(res.notification.request.content.data ?? {}).slice(0, 200)}`;
  const key = `${id}:${res.actionIdentifier}`;
  if (handled.includes(key)) return false;
  handled.push(key);
  if (handled.length > KEEP) handled.splice(0, handled.length - KEEP);
  void SecureStore.setItemAsync(KEY, JSON.stringify(handled)).catch(() => {});
  const sent = sentAt(res);
  return sent === null || Date.now() - sent < MAX_AGE_MS;
}
