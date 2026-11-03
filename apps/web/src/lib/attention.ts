import type { Session } from "@renki/protocol";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useClient } from "./client.js";

/**
 * The tab's title: the open chat's name, led by "Needs you" when that chat is
 * waiting on an approval. Only that tab says so: with every Renki tab saying
 * "(1) Needs you", none of them told you which one it was. SessionView sets
 * the name and which chat is open, useAttentionAlerts which chats wait.
 */
let baseTitle = "Renki";
let openChat: string | null = null;
const waitingChats = new Set<string>();
function applyTitle() {
  document.title = openChat && waitingChats.has(openChat) ? `Needs you · ${baseTitle}` : baseTitle;
}
export function setTabTitle(title: string, sessionId: string | null = null): void {
  baseTitle = title;
  openChat = sessionId;
  applyTitle();
}

const NOTIFY_KEY = "renki.notify";

/** Whether this browser should notify, as chosen in Settings (and allowed by the browser). */
export function notificationsOn(): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(NOTIFY_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Turn notifications on (asking the browser first) or off. Resolves to whether they're on now. */
export async function setNotifications(on: boolean): Promise<boolean> {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable: the browser's own permission still decides.
  }
  if (!on || typeof Notification === "undefined") return false;
  if (Notification.permission === "default") await Notification.requestPermission();
  return notificationsOn();
}

/**
 * Watches every chat for one that starts waiting on an approval (a tool to
 * allow, a question to answer): marks the tab showing it (see setTabTitle) and, while
 * this tab isn't being looked at, shows a browser notification that opens the
 * chat. Before this a background tab gave no sign at all.
 */
export function useAttentionAlerts(): void {
  const { rest, realtime } = useClient();
  const navigate = useNavigate();

  useEffect(() => {
    const pending = waitingChats;
    const update = applyTitle;
    const see = (s: Session, announce: boolean) => {
      const was = pending.has(s.id);
      if (s.hasPendingPermission) pending.add(s.id);
      else pending.delete(s.id);
      if (s.hasPendingPermission && !was && announce) notify(s);
      update();
    };
    const notify = (s: Session) => {
      if (!notificationsOn() || document.visibilityState === "visible") return;
      const n = new Notification(s.title || s.repoName || "Renki", { body: "Waiting for your approval", tag: `renki-${s.id}` });
      n.onclick = () => {
        window.focus();
        navigate(`/session/${encodeURIComponent(s.id)}`);
        n.close();
      };
    };

    let live = true;
    // Already waiting when the tab opened: marked, not announced.
    rest
      .listSessions()
      .then((list) => live && list.forEach((s) => see(s, false)))
      .catch(() => {});
    const offChanged = realtime.onSessionChanged((s) => see(s, true));
    const offRemoved = realtime.onSessionRemoved((id) => {
      pending.delete(id);
      update();
    });
    return () => {
      live = false;
      offChanged();
      offRemoved();
      pending.clear();
      applyTitle();
    };
  }, [rest, realtime, navigate]);
}
