import type { Session } from "@crc/protocol";

/**
 * When the take-control lock should be released automatically.
 *
 * The point of releasing it at all is a device that wandered off — a closed
 * laptop still holding a session hostage from your phone. It is NOT meant to
 * punish reading: sitting on a long transcript for twenty minutes with the tab
 * open used to lose you the lock, which is worse than the problem it solves,
 * because the fix (take control again) is manual and the loss is silent.
 *
 * So a controller that still has a live WebSocket keeps the lock indefinitely.
 * The timeout applies only once that device is actually gone, measured from
 * the last thing that happened in the session.
 */
export function shouldReleaseIdleControl(
  session: Pick<Session, "controller" | "status" | "lastActivityAt">,
  isOnline: (deviceId: string) => boolean,
  now: number,
  idleMs: number,
): boolean {
  if (!session.controller) return false;
  // A running turn is activity by definition, whoever is watching.
  if (session.status === "busy") return false;
  // Still connected — they're here, whether or not they're typing.
  if (isOnline(session.controller)) return false;
  return now - session.lastActivityAt > idleMs;
}
