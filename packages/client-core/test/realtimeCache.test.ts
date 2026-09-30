import type { SessionEvent } from "@renki/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEvents, initialConversation, type ConversationState } from "../src/reducer.js";
import { type ConversationCache, RealtimeClient } from "../src/realtime.js";

/** A WebSocket stand-in: records what the client sends and lets a test play the daemon. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const ev = (seq: number, payload: Record<string, unknown>) => ({ seq, sessionId: "s1", ts: 0, ...payload }) as SessionEvent;
const history = [
  ev(0, { kind: "status_changed", status: "idle" }),
  ev(1, { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "hello" }),
];

function memoryCache(initial?: ConversationState) {
  const saved = new Map<string, ConversationState>();
  if (initial) saved.set(initial.sessionId, initial);
  const cache: ConversationCache = {
    load: vi.fn(async (id) => saved.get(id) ?? null),
    save: vi.fn(async (id, state) => void saved.set(id, state)),
    remove: vi.fn(async (id) => void saved.delete(id)),
  };
  return { cache, saved };
}

function connect(cache?: ConversationCache) {
  const client = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1", cache });
  client.connect();
  const socket = FakeSocket.last!;
  socket.open();
  return { client, socket };
}

const subscribes = (socket: FakeSocket) => socket.sent.filter((m) => m.type === "subscribe");

beforeEach(() => {
  vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RealtimeClient conversation cache", () => {
  it("shows the cached copy first, then asks only for what came after it", async () => {
    const cached = applyEvents(initialConversation("s1"), history);
    const { cache } = memoryCache(cached);
    const { client, socket } = connect(cache);

    const store = client.watch("s1");
    await vi.waitFor(() => expect(subscribes(socket)).toHaveLength(1));
    expect(store.get().timeline).toHaveLength(1);
    expect(subscribes(socket)[0]).toMatchObject({ sessionId: "s1", lastSeq: 1 });
  });

  it("asks for everything when nothing is cached", async () => {
    const { cache } = memoryCache();
    const { client, socket } = connect(cache);
    client.watch("s1");
    await vi.waitFor(() => expect(subscribes(socket)).toHaveLength(1));
    expect(subscribes(socket)[0]).toMatchObject({ lastSeq: -1 });
  });

  it("saves after a replay lands, and on leaving the chat", async () => {
    vi.useFakeTimers();
    const { cache, saved } = memoryCache();
    const { client, socket } = connect(cache);
    client.watch("s1");
    await vi.advanceTimersByTimeAsync(0);
    socket.receive({ type: "replay", sessionId: "s1", events: history, upToSeq: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saved.get("s1")?.lastSeq).toBe(1);

    socket.receive({ type: "event", event: ev(2, { kind: "status_changed", status: "busy" }) });
    expect(cache.save).toHaveBeenCalledTimes(1); // a live event alone doesn't write
    client.unwatch("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.get("s1")?.lastSeq).toBe(2);
  });

  it("writes unsaved conversations when told the app is going away", async () => {
    const { cache, saved } = memoryCache();
    const { client, socket } = connect(cache);
    client.watch("s1");
    await vi.waitFor(() => expect(subscribes(socket)).toHaveLength(1));
    socket.receive({ type: "event", event: ev(0, { kind: "status_changed", status: "idle" }) });
    client.flushCache();
    await vi.waitFor(() => expect(saved.get("s1")?.lastSeq).toBe(0));
  });

  it("forgets a purged session's cached copy", async () => {
    const { cache } = memoryCache(applyEvents(initialConversation("s1"), history));
    const { socket } = connect(cache);
    socket.receive({ type: "session_removed", sessionId: "s1" });
    await vi.waitFor(() => expect(cache.remove).toHaveBeenCalledWith("s1"));
  });

  it("behaves as before without a cache", () => {
    const { client, socket } = connect();
    client.watch("s1");
    expect(subscribes(socket)).toEqual([{ type: "subscribe", sessionId: "s1", lastSeq: -1, lazyAttachments: true }]);
  });
});

describe("RealtimeClient dead-connection recovery", () => {
  it("reconnects when the socket goes silent, and asks for what it missed", async () => {
    vi.useFakeTimers();
    const { client, socket } = connect();
    client.watch("s1");
    socket.receive({ type: "replay", sessionId: "s1", events: history, upToSeq: 1 });

    // Pings go out, nothing comes back: a half-dead socket that never reports closing.
    await vi.advanceTimersByTimeAsync(60_000);
    const fresh = FakeSocket.last!;
    expect(fresh).not.toBe(socket);
    fresh.open();
    expect(subscribes(fresh)).toEqual([{ type: "subscribe", sessionId: "s1", lastSeq: 1, lazyAttachments: true }]);
  });

  it("keeps a socket that keeps answering", async () => {
    vi.useFakeTimers();
    const { socket } = connect();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      socket.receive({ type: "pong" });
    }
    expect(FakeSocket.last).toBe(socket);
  });

  it("checks the connection on demand — coming back to the app — and reconnects if nothing answers", async () => {
    vi.useFakeTimers();
    const { client, socket } = connect();
    client.checkConnection();
    socket.receive({ type: "pong" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(FakeSocket.last).toBe(socket);

    client.checkConnection();
    expect(socket.sent.at(-1)).toEqual({ type: "ping" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(FakeSocket.last).not.toBe(socket);
  });
});
