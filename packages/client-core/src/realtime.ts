import {
  type ClientMessage,
  type PermissionDecision,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
} from "@crc/protocol";
import type { PermissionModeKey } from "./permissionMode.js";
import { type ConversationState, applyEvent, applyEvents, initialConversation } from "./reducer.js";
import { Store } from "./store.js";

/**
 * The real-time client. Owns ONE WebSocket to the daemon and:
 *  - auto-reconnects with backoff,
 *  - keeps a ConversationState store per watched session,
 *  - on every (re)connect, resubscribes each watched session with its stored
 *    lastSeq so the daemon replays exactly the gap — reconnection is invisible
 *    to the UI and can never leave it stale,
 *  - exposes typed actions (take/release control, prompt, resolve permission).
 *
 * The stores are useSyncExternalStore-ready, so a React hook is a one-liner and
 * the same objects work unchanged in React Native.
 */
export type ConnectionStatus = "connecting" | "open" | "closed";

export type WsError = { code: string; message: string; ref: string | null };

export type RealtimeOptions = {
  baseUrl: string; // http(s)://host:port
  token: string;
  deviceId: string;
  deviceName?: string;
};

export class RealtimeClient {
  readonly status = new Store<ConnectionStatus>("closed");
  /** Last WS-level error (e.g. not_controller, session_busy). UI can toast it. */
  readonly lastError = new Store<WsError | null>(null);

  private ws: WebSocket | null = null;
  private readonly conversations = new Map<string, Store<ConversationState>>();
  private readonly watched = new Set<string>();
  private readonly pendingUnwatch = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly opts: RealtimeOptions) {}

  // ── connection lifecycle ─────────────────────────────────────────────────

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.clearPendingUnwatches();
    this.ws?.close();
    this.ws = null;
    this.status.set("closed");
  }

  private open(): void {
    this.status.set("connecting");
    const url = this.wsUrl();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.status.set("open");
      // Resubscribe everything we were watching, resuming from each lastSeq.
      for (const sessionId of this.watched) this.sendSubscribe(sessionId);
      this.startPing();
    };

    ws.onmessage = (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));

    ws.onclose = () => {
      this.clearTimers();
      this.status.set("closed");
      if (!this.stopped) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow and drive reconnection; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  // ── watching sessions ─────────────────────────────────────────────────────

  /** Get (creating if needed) the reactive state store for a session. */
  conversation(sessionId: string): Store<ConversationState> {
    let store = this.conversations.get(sessionId);
    if (!store) {
      store = new Store(initialConversation(sessionId));
      this.conversations.set(sessionId, store);
    }
    return store;
  }

  /**
   * Begin receiving live events for a session (and replay what we missed).
   *
   * If an `unwatch` for this session is still pending (e.g. React StrictMode's
   * mount → cleanup → mount double-invoke), cancel the teardown instead of
   * tearing down and immediately resubscribing — otherwise the daemon would
   * receive two overlapping `subscribe` requests carrying the same stale
   * `lastSeq` and reply with two full replays, duplicating every event.
   *
   * Also a no-op (beyond returning the store) if we're already watching —
   * e.g. two components watching the same session, or any other caller that
   * invokes `watch` again without an intervening `unwatch`. Without this check
   * every extra call would fire off another `subscribe` at the same stale
   * `lastSeq`, and the daemon would happily reply with another full replay on
   * top of what's already folded in.
   */
  watch(sessionId: string): Store<ConversationState> {
    const store = this.conversation(sessionId);
    const pending = this.pendingUnwatch.get(sessionId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingUnwatch.delete(sessionId);
      return store;
    }
    const alreadyWatching = this.watched.has(sessionId);
    this.watched.add(sessionId);
    if (!alreadyWatching && this.isOpen()) this.sendSubscribe(sessionId);
    return store;
  }

  /** Deferred so a same-tick `watch` (see above) can cancel the teardown. */
  unwatch(sessionId: string): void {
    const existing = this.pendingUnwatch.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingUnwatch.delete(sessionId);
      this.watched.delete(sessionId);
      if (this.isOpen()) this.send({ type: "unsubscribe", sessionId });
    }, 0);
    this.pendingUnwatch.set(sessionId, timer);
  }

  // ── actions (controller-only ones are enforced server-side) ────────────────

  takeControl(sessionId: string): void {
    this.send({ type: "take_control", sessionId });
  }

  releaseControl(sessionId: string): void {
    this.send({ type: "release_control", sessionId });
  }

  /**
   * Returns the client-generated promptId so the UI can correlate it.
   * `model`/`maxThinkingTokens`/`permissionMode` are a per-message override —
   * omit for the daemon's own default, matching every call site before these
   * options existed.
   */
  submitPrompt(
    sessionId: string,
    text: string,
    opts?: { model?: string; maxThinkingTokens?: number | null; permissionMode?: PermissionModeKey },
  ): string {
    const promptId = genId("p");
    this.send({ type: "submit_prompt", sessionId, promptId, text, ...opts });
    return promptId;
  }

  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.send({ type: "resolve_permission", sessionId, requestId, decision });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private sendSubscribe(sessionId: string): void {
    const lastSeq = this.conversation(sessionId).get().lastSeq;
    this.send({ type: "subscribe", sessionId, lastSeq });
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = ServerMessageSchema.safeParse(parsed);
    if (!result.success) return;
    this.route(result.data);
  }

  private route(msg: ServerMessage): void {
    switch (msg.type) {
      case "replay": {
        const store = this.conversation(msg.sessionId);
        store.update((s) => applyEvents(s, msg.events));
        return;
      }
      case "event": {
        const store = this.conversation(msg.event.sessionId);
        store.update((s) => applyEvent(s, msg.event));
        return;
      }
      case "error":
        this.lastError.set({ code: msg.code, message: msg.message, ref: msg.ref });
        return;
      case "subscribed":
      case "pong":
        return;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.isOpen()) this.ws!.send(JSON.stringify(msg));
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 25_000);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private clearPendingUnwatches(): void {
    for (const timer of this.pendingUnwatch.values()) clearTimeout(timer);
    this.pendingUnwatch.clear();
  }

  private wsUrl(): string {
    const base = this.opts.baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const q = new URLSearchParams({ token: this.opts.token, deviceId: this.opts.deviceId });
    if (this.opts.deviceName) q.set("deviceName", this.opts.deviceName);
    return `${base}/ws?${q.toString()}`;
  }
}

let counter = 0;
function genId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
