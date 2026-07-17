import type { SessionEvent } from "@crc/protocol";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import type { DeviceRegistry } from "./devices.js";
import type { PushTokenStore } from "./tokens.js";

/**
 * Turns interesting session events into Expo push notifications.
 *
 * Policy (v1): notify the session's CONTROLLER — the person driving — when
 *   - Claude needs a permission decision (actionable, time-sensitive), or
 *   - a turn finishes (so you can come back and read/continue),
 * but only if that device is NOT currently connected. If they're watching live
 * they don't need a push. Fire-and-forget: a push failure never affects the
 * session.
 */
export class Notifier {
  constructor(
    private readonly config: Config,
    private readonly manager: SessionManager,
    private readonly devices: DeviceRegistry,
    private readonly tokens: PushTokenStore,
  ) {}

  /** Attach to the event log. Returns an unsubscribe fn. */
  attach(): () => void {
    return this.manager.events.onAny((event) => this.onEvent(event));
  }

  private onEvent(event: SessionEvent): void {
    if (event.kind !== "permission_request" && event.kind !== "turn_result") return;

    let session;
    try {
      session = this.manager.getSession(event.sessionId);
    } catch {
      return;
    }
    const controller = session.controller;
    if (!controller || this.devices.isOnline(controller)) return; // watching live -> stay quiet

    const token = this.tokens.get(controller);
    if (!token) return;

    const label = session.title || `${session.repoName}:${session.branch}`;
    const notification =
      event.kind === "permission_request"
        ? { title: `Permission needed · ${label}`, body: `Claude wants to use ${event.toolName}` }
        : {
            title: event.ok ? `Turn complete · ${label}` : `Turn failed · ${label}`,
            body: event.ok ? "Claude finished responding." : (event.errorMessage ?? "The turn errored."),
          };

    void this.send(token.expoToken, notification, event.sessionId);
  }

  private async send(to: string, n: { title: string; body: string }, sessionId: string): Promise<void> {
    try {
      const res = await fetch(this.config.expoPushUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ to, title: n.title, body: n.body, data: { sessionId }, priority: "high" }),
      });
      if (!res.ok) logger.warn("expo push non-ok", { status: res.status });
    } catch (err) {
      logger.warn("expo push failed", { err: String(err) });
    }
  }
}
