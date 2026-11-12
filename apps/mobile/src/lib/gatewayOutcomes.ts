import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import { describeMentions, parseGatewayApproval, settledToMention, type SettledForNotice } from "@renki/client-core";

/**
 * Telling the user what became of a homelab request whose notification they swiped away (or never
 * opened). The gateway says nothing more once a request closes, on purpose: more pushes were the
 * complaint. Instead the daemon passes on the gateway's list of what closed lately (realtime's
 * gatewayRecent), and the app, when it's open, says in one toast what it hasn't said yet: "Expired,
 * nothing ran: <command>". Settings > Homelab approvals lists the last few in full.
 *
 * "Not said yet" is a high-water mark of the last closing time already looked at, kept across
 * launches. The first time (a fresh install, or the first build with this) it starts a quarter of
 * an hour back, so a request that just expired is still mentioned but day-old history isn't.
 */
const KEY = "renki.gatewaySeenUntil";
const FIRST_LOOK_BACK_MS = 15 * 60 * 1000;

let seenUntil: number | null = null;
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) seenUntil = Math.max(seenUntil ?? 0, n);
    })
    .catch(() => {});
  return loaded;
}

/**
 * What to toast about this list of closed requests, if anything, and mark them all as looked at.
 * `skip`: requests the user can already see (the approval popup showing one says how it ended).
 */
export async function takeGatewayMentions(recent: SettledForNotice[], skip: ReadonlySet<string>): Promise<string | null> {
  await load();
  const since = seenUntil ?? Date.now() - FIRST_LOOK_BACK_MS;
  const mention = settledToMention(recent, since, skip);
  const newest = recent.reduce((m, r) => Math.max(m, r.settled), since);
  if (newest !== seenUntil) {
    seenUntil = newest;
    void SecureStore.setItemAsync(KEY, String(newest)).catch(() => {});
  }
  return describeMentions(mention);
}

/**
 * Take the notifications for these requests out of the tray: they're closed, and a stale "Approve on
 * the homelab?" left there only invites a tap that can no longer do anything. Covers every copy, since
 * a request pushed again (a resend) leaves a second notification for the same request.
 */
export async function clearGatewayFromTray(ids: ReadonlySet<string>): Promise<void> {
  if (ids.size === 0) return;
  try {
    const list = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      list
        .filter((n) => {
          const a = parseGatewayApproval(n.request.content.data);
          return a !== null && ids.has(a.id);
        })
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {})),
    );
  } catch {
    // Only tidying: nothing to say if it fails.
  }
}

/**
 * Settings' "Show" on a waiting request asks the gateway to push it again. Its copy arrives while the
 * app is open, where a request already shown once this run doesn't pop up again by itself ("Not now"
 * means not now); for a minute after asking, one arriving does.
 */
let popupWantedUntil = 0;

export function wantGatewayPopup(): void {
  popupWantedUntil = Date.now() + 60_000;
}

export function gatewayPopupWanted(): boolean {
  return Date.now() < popupWantedUntil;
}
