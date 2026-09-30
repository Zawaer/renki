import {
  type Attachment,
  type ClientMessage,
  type PermissionDecision,
  type Session,
  type SessionComposer,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
} from "@renki/protocol";
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

/**
 * Somewhere to keep conversations between visits, so opening a long chat
 * shows it straight away and only the events since are fetched — instead of
 * the whole history, which for a long session is many megabytes. Optional;
 * each client supplies its own storage (the phone uses its file system).
 *
 * Holds folded state, so the key must change whenever folding does — see
 * CONVERSATION_CACHE_VERSION.
 */
export type ConversationCache = {
  load(sessionId: string): Promise<ConversationState | null>;
  save(sessionId: string, state: ConversationState): Promise<void>;
  remove(sessionId: string): Promise<void>;
};

export type RealtimeOptions = {
  baseUrl: string; // http(s)://host:port
  token: string;
  deviceId: string;
  deviceName?: string;
  cache?: ConversationCache;
};

/** How long after a replay lands to write it to the cache — long enough to coalesce a reconnect's burst. */
const CACHE_SAVE_DELAY_MS = 1_500;

/** Field-wise equality for a session's pinned composer settings. */
function sameComposer(a: SessionComposer | null, b: SessionComposer | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.model === b.model && a.effortKey === b.effortKey && a.permissionMode === b.permissionMode;
}

export class RealtimeClient {
  readonly status = new Store<ConnectionStatus>("closed");
  /** Last WS-level error (e.g. not_controller, session_busy). UI can toast it. */
  readonly lastError = new Store<WsError | null>(null);

  private ws: WebSocket | null = null;
  private readonly conversations = new Map<string, Store<ConversationState>>();
  private readonly watched = new Set<string>();
  private readonly sessionListeners = new Set<(session: Session) => void>();
  private readonly sessionRemovedListeners = new Set<(sessionId: string) => void>();
  private readonly pendingUnwatch = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions whose cached state is still being read; their subscribe waits for it. */
  private readonly hydrating = new Set<string>();
  /** Sessions with state the cache hasn't seen yet. */
  private readonly unsaved = new Set<string>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      for (const sessionId of this.watched) if (!this.hydrating.has(sessionId)) this.sendSubscribe(sessionId);
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
    if (alreadyWatching) return store;
    // Never loaded this run: show the cached copy first, then ask only for
    // what came after it. The subscribe waits, or it would ask for everything.
    if (this.opts.cache && store.get().lastSeq < 0 && !this.hydrating.has(sessionId)) {
      this.hydrate(sessionId, store);
      return store;
    }
    if (this.isOpen()) this.sendSubscribe(sessionId);
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
      this.saveNow(sessionId);
    }, 0);
    this.pendingUnwatch.set(sessionId, timer);
  }

  // ── actions (controller-only ones are enforced server-side) ────────────────

  takeControl(sessionId: string): void {
    this.send({ type: "take_control", sessionId });
  }

  /**
   * Returns the client-generated promptId so the UI can correlate it.
   * `model`/`maxThinkingTokens`/`permissionMode` are a per-message override —
   * omit for the daemon's own default, matching every call site before these
   * options existed. `attachments` travel inline as base64 (see
   * `@renki/protocol`'s `Attachment`) and become real image/document content
   * blocks for the model — `text` may be empty if at least one is present.
   */
  submitPrompt(
    sessionId: string,
    text: string,
    opts?: {
      model?: string;
      maxThinkingTokens?: number | null;
      permissionMode?: PermissionModeKey;
      attachments?: Attachment[];
    },
  ): string {
    const promptId = genId("p");
    this.send({ type: "submit_prompt", sessionId, promptId, text, ...opts });
    return promptId;
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.send({ type: "resolve_permission", sessionId, requestId, decision, updatedInput });
  }

  /** Stop the turn currently running for this session (the "stop" button). */
  interrupt(sessionId: string): void {
    this.send({ type: "interrupt", sessionId });
  }

  /** Cancel a session's scheduled resume, or run it now instead of waiting for the reset. */
  resumeAction(sessionId: string, action: "cancel" | "now"): void {
    this.send({ type: "resume_action", sessionId, action });
  }

  /**
   * Push a live permission-mode change to the turn currently running for
   * this session, if any (a no-op daemon-side when idle — the next
   * `submitPrompt`'s own `permissionMode` already carries the new choice).
   */
  setPermissionMode(sessionId: string, mode: PermissionModeKey): void {
    this.send({ type: "set_permission_mode", sessionId, mode });
  }

  /**
   * Fleet-wide session-list pushes — a session's roster-relevant fields
   * changed (status, controller, hasPendingPermission, etc). Unlike
   * `conversation`/`watch`, no subscribe is needed: the daemon pushes every
   * change to every connected client. A session list view should still do an
   * initial REST fetch (and an occasional slow re-fetch as a safety net for
   * anything missed during a disconnect) but can otherwise stay live off this.
   */
  onSessionChanged(cb: (session: Session) => void): () => void {
    this.sessionListeners.add(cb);
    return () => this.sessionListeners.delete(cb);
  }

  /** A session was permanently deleted (archival comes through `onSessionChanged`). */
  onSessionRemoved(cb: (sessionId: string) => void): () => void {
    this.sessionRemovedListeners.add(cb);
    return () => this.sessionRemovedListeners.delete(cb);
  }

  /**
   * Write every conversation with unsaved changes to the cache now — call when
   * the app is about to be backgrounded, since it may never come back.
   */
  flushCache(): void {
    for (const sessionId of [...this.unsaved]) this.saveNow(sessionId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private hydrate(sessionId: string, store: Store<ConversationState>): void {
    this.hydrating.add(sessionId);
    this.opts
      .cache!.load(sessionId)
      .catch(() => null)
      .then((cached) => {
        // Anything folded meanwhile wins; a cached copy is only a head start.
        if (cached && cached.sessionId === sessionId && cached.lastSeq > store.get().lastSeq) store.set(cached);
      })
      .finally(() => {
        this.hydrating.delete(sessionId);
        if (this.watched.has(sessionId) && this.isOpen()) this.sendSubscribe(sessionId);
      });
  }

  /** Save soon — after a replay, when the state has jumped and is worth keeping. */
  private scheduleSave(sessionId: string): void {
    if (!this.opts.cache) return;
    this.unsaved.add(sessionId);
    const existing = this.saveTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    this.saveTimers.set(
      sessionId,
      setTimeout(() => this.saveNow(sessionId), CACHE_SAVE_DELAY_MS),
    );
  }

  private saveNow(sessionId: string): void {
    const timer = this.saveTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.saveTimers.delete(sessionId);
    if (!this.opts.cache || !this.unsaved.has(sessionId)) return;
    this.unsaved.delete(sessionId);
    const state = this.conversations.get(sessionId)?.get();
    if (state && state.lastSeq >= 0) void this.opts.cache.save(sessionId, state).catch(() => {});
  }

  private sendSubscribe(sessionId: string): void {
    const lastSeq = this.conversation(sessionId).get().lastSeq;
    // Screenshots in a long chat's history are most of its size; fetch each
    // one when it's actually shown instead (see attachmentSource).
    this.send({ type: "subscribe", sessionId, lastSeq, lazyAttachments: true });
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
        if (msg.events.length > 0) this.scheduleSave(msg.sessionId);
        return;
      }
      case "event": {
        const store = this.conversation(msg.event.sessionId);
        store.update((s) => applyEvent(s, msg.event));
        // Marked, not saved: writing a long transcript on every streamed token
        // would stutter the reply. It's written on leaving or backgrounding.
        if (this.opts.cache) this.unsaved.add(msg.event.sessionId);
        return;
      }
      case "error":
        this.lastError.set({ code: msg.code, message: msg.message, ref: msg.ref });
        return;
      case "session": {
        // Roster listeners (the session list) plus, when this session is open,
        // its conversation store — that's how a composer pick made on another
        // device lands in this one's pickers without a refresh. Only an
        // EXISTING store is touched: `conversation()` would otherwise mint one
        // for every session in the roster on every unrelated change.
        for (const cb of this.sessionListeners) cb(msg.session);
        const store = this.conversations.get(msg.session.id);
        if (store) {
          const composer = msg.session.composer ?? null;
          // By VALUE, not identity: every push carries a freshly parsed object,
          // and swapping in an equal one on each unrelated session change (a
          // status flip, say) would keep re-notifying subscribers. A composer
          // that re-arrives mid-edit would then stomp the pick the user just
          // made while its own request is still in flight.
          store.update((s) => (sameComposer(s.composer, composer) ? s : { ...s, composer }));
        }
        return;
      }
      case "session_removed":
        for (const cb of this.sessionRemovedListeners) cb(msg.sessionId);
        // Purged for good: don't keep its transcript on the device either.
        this.unsaved.delete(msg.sessionId);
        void this.opts.cache?.remove(msg.sessionId).catch(() => {});
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
