import {
  type ClientMessage,
  ClientMessage as ClientMessageSchema,
  type SessionEvent,
  type ServerMessage,
  WsErrorCode,
} from "@crc/protocol";
import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import type { DeviceRegistry } from "../push/devices.js";
import { SessionError } from "../sessions/errors.js";
import type { SessionManager } from "../sessions/manager.js";
import type { PermissionBroker } from "./permissions.js";

/**
 * One live client connection (one browser tab / phone / VS Code webview).
 *
 * A connection is identified by a persistent `deviceId` (supplied on the
 * upgrade query string), NOT by the socket itself. That's deliberate: the lock
 * is tied to the device, so a brief network blip + reconnect doesn't drop
 * control — the same device just resubscribes and reclaims its place.
 *
 * The connection is a thin adapter: it validates/parses messages, calls the
 * transport-agnostic SessionManager, and forwards event-log events to this
 * socket. It holds NO session state of its own beyond "which sessions am I
 * watching" — all truth lives in the manager + event log.
 */
export class Connection {
  /** sessionId -> unsubscribe fn for the live event-log listener. */
  private readonly subs = new Map<string, () => void>();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    readonly deviceId: string,
    readonly deviceName: string | null,
    private readonly manager: SessionManager,
    private readonly broker: PermissionBroker,
    private readonly devices: DeviceRegistry,
    private readonly onClosed?: () => void,
  ) {
    this.devices.connect(deviceId); // mark online so the notifier stays quiet
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", () => this.onClose());
    socket.on("error", (err) => logger.warn("socket error", { deviceId, err: String(err) }));
  }

  /** Fleet-wide push (session list changes) — independent of any per-session subscription. */
  notify(msg: ServerMessage): void {
    this.send(msg);
  }

  private send(msg: ServerMessage): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify(msg));
  }

  private error(code: string, message: string, ref: string | null = null): void {
    this.send({ type: "error", code, message, ref });
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.error(WsErrorCode.BadMessage, "Invalid JSON.");
    }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      return this.error(WsErrorCode.BadMessage, "Unrecognized message shape.");
    }

    try {
      this.dispatch(result.data);
    } catch (err) {
      if (err instanceof SessionError) this.error(err.code, err.message);
      else {
        logger.error("dispatch failed", { deviceId: this.deviceId, err: String(err) });
        this.error("internal", "Internal error.");
      }
    }
  }

  private dispatch(msg: ClientMessage): void {
    switch (msg.type) {
      case "ping":
        return this.send({ type: "pong" });

      case "subscribe":
        return this.subscribe(msg.sessionId, msg.lastSeq);

      case "unsubscribe":
        return this.unsubscribe(msg.sessionId);

      case "take_control": {
        this.manager.takeControl(msg.sessionId, this.deviceId, this.deviceName ?? undefined);
        // No direct reply: the resulting control_changed event is the truth and
        // reaches every subscriber (including this one) via the log.
        return;
      }

      case "submit_prompt": {
        // Fire-and-forget: the turn streams via the event log, and we must keep
        // processing this socket's messages (e.g. resolve_permission) WHILE the
        // turn runs. So we don't await it here.
        this.manager
          .submitPrompt({
            sessionId: msg.sessionId,
            deviceId: this.deviceId,
            promptId: msg.promptId,
            text: msg.text,
            attachments: msg.attachments,
            model: msg.model,
            maxThinkingTokens: msg.maxThinkingTokens,
            permissionMode: msg.permissionMode,
            resolvePermission: this.broker.resolverFor(msg.sessionId),
          })
          .catch((err) => {
            if (err instanceof SessionError) this.error(err.code, err.message, msg.promptId);
            else {
              logger.error("submit_prompt failed", { sessionId: msg.sessionId, err: String(err) });
              this.error("internal", "Turn failed to start.", msg.promptId);
            }
          });
        return;
      }

      case "interrupt": {
        this.manager.interruptSession(msg.sessionId, this.deviceId);
        // No direct reply: the resulting turn_result/status_changed events are
        // the truth and reach every subscriber (including this one) via the log.
        return;
      }

      case "set_permission_mode": {
        this.manager.setPermissionMode(msg.sessionId, this.deviceId, msg.mode);
        // No direct reply: this only affects the live turn's next tool checks;
        // there's no event to broadcast for it.
        return;
      }

      case "resolve_permission": {
        // Only the current controller may answer a permission request.
        const session = this.manager.getSession(msg.sessionId);
        if (session.controller !== this.deviceId) {
          return this.error(WsErrorCode.NotController, "Only the controller can resolve permissions.");
        }
        const matched = this.broker.answer(msg.requestId, msg.decision, this.deviceId, msg.updatedInput);
        if (!matched) this.error(WsErrorCode.BadMessage, "No such pending permission request.", msg.requestId);
        return;
      }
    }
  }

  /**
   * Gap-free replay-then-live. We attach the live listener FIRST (buffering),
   * then read the missed events, then flush the buffer while de-duping on seq.
   * Because append + subscribe are synchronous, nothing can be lost or doubled
   * between "caught up" and "streaming live".
   */
  private subscribe(sessionId: string, lastSeq: number): void {
    this.manager.getSession(sessionId); // throws SessionError if unknown
    this.unsubscribe(sessionId); // idempotent re-subscribe

    let buffer: SessionEvent[] | null = [];
    const off = this.manager.events.subscribe(sessionId, (evt) => {
      if (buffer) buffer.push(evt);
      else this.send({ type: "event", event: evt });
    });
    this.subs.set(sessionId, off);

    const replay = this.manager.events.read(sessionId, lastSeq);
    const upTo = replay.length > 0 ? replay[replay.length - 1]!.seq : lastSeq;

    this.send({ type: "subscribed", sessionId, currentSeq: upTo });
    this.send({ type: "replay", sessionId, events: replay, upToSeq: upTo });

    const buffered = buffer;
    buffer = null; // switch to live pass-through
    for (const evt of buffered) if (evt.seq > upTo) this.send({ type: "event", event: evt });
  }

  private unsubscribe(sessionId: string): void {
    const off = this.subs.get(sessionId);
    if (off) {
      off();
      this.subs.delete(sessionId);
    }
  }

  private onClose(): void {
    this.closed = true;
    this.devices.disconnect(this.deviceId); // now push-eligible again
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.onClosed?.();
    // NOTE: we deliberately do NOT release control here. On mobile a dropped
    // socket usually means "app backgrounded", not "done" — and releasing would
    // kill the very controller we need to push a permission request to. The
    // idle-timeout sweep reclaims it eventually, so it still can't get stuck,
    // but a backgrounded phone keeps its lock long enough to receive a push,
    // reopen, and approve.
    logger.info("connection closed", { deviceId: this.deviceId });
  }
}
