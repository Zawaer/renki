import type { SessionEvent } from "@renki/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEvent, applyEvents, initialConversation, latestOf, prependOlder } from "../src/reducer.js";
import { RealtimeClient } from "../src/realtime.js";

const ev = (seq: number, payload: Record<string, unknown>) => ({ seq, sessionId: "s1", ts: 1000 + seq, ...payload }) as SessionEvent;

/** `n` finished prompt/turn pairs: 2n timeline items, seqs 0..4n-1. */
function chat(n: number) {
  const events: SessionEvent[] = [];
  for (let i = 0; i < n; i++) {
    const seq = i * 4;
    events.push(
      ev(seq, { kind: "prompt_submitted", promptId: `p${i}`, deviceId: "d1", text: `q${i}` }),
      ev(seq + 1, { kind: "turn_started", turnId: `t${i}`, promptId: `p${i}`, trigger: "prompt" }),
      ev(seq + 2, { kind: "assistant_block", turnId: `t${i}`, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: `u${i}`, toolName: "Agent", toolInput: {} }),
      ev(seq + 3, { kind: "turn_result", turnId: `t${i}`, promptId: `p${i}`, ok: true, costUsd: 0, durationMs: 1, inputTokens: 0, outputTokens: 0 }),
    );
  }
  return applyEvents(initialConversation("s1"), events);
}

describe("reducer: a chat opened from its latest turns", () => {
  it("keeps the last items, starting at a prompt, and counts the rest", () => {
    const tail = latestOf(chat(10), 5);
    // 20 items; the last 5 start mid-turn, so the cut moves back to that turn's prompt.
    expect(tail.olderItems).toBe(14);
    expect(tail.timeline).toHaveLength(6);
    expect(tail.timeline[0]?.type).toBe("prompt");
  });

  it("leaves a short chat whole", () => {
    expect(latestOf(chat(2), 40).olderItems).toBeUndefined();
  });

  it("puts older history back in front, in order", () => {
    const full = chat(10);
    const tail = latestOf(full, 4);
    const back = prependOlder(prependOlder(tail, full.timeline.slice(10, 16), 10), full.timeline.slice(0, 10), 0);
    expect(back.timeline).toEqual(full.timeline);
    expect(back.olderItems).toBe(0);
  });

  it("drops events for a turn that isn't loaded, rather than inventing one", () => {
    const tail = latestOf(chat(10), 4);
    const next = applyEvent(tail, ev(100, { kind: "tool_result", turnId: "t0", toolUseId: "x", ok: true, summary: "late" }));
    expect(next.timeline).toBe(tail.timeline);
  });

  it("drops an unknown agent's outcome while older history is missing, instead of a loose row", () => {
    const tail = latestOf(chat(10), 4);
    const next = applyEvent(tail, ev(100, { kind: "background_task", toolUseId: "u0", taskId: "k", status: "completed", summary: "done" }));
    expect(next.timeline).toBe(tail.timeline);
  });
});

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

describe("RealtimeClient: opening from a snapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the latest turns, then fetches the rest page by page", async () => {
    const full = chat(200); // 400 items
    const tail = latestOf(full, 40);
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      const end = Number(q.get("end"));
      const start = Math.max(0, end - Number(q.get("limit")));
      return new Response(JSON.stringify({ items: full.timeline.slice(start, end), start }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
    client.connect();
    const socket = FakeSocket.last!;
    socket.open();
    const store = client.watch("s1");
    socket.receive({ type: "snapshot", sessionId: "s1", state: tail, upToSeq: full.lastSeq });
    expect(store.get().timeline).toHaveLength(tail.timeline.length);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.get().timeline).toEqual(full.timeline);
    expect(store.get().olderItems).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(Math.ceil((tail.olderItems ?? 0) / 120));
    // Live events still fold on top.
    socket.receive({ type: "event", event: ev(full.lastSeq + 1, { kind: "status_changed", status: "busy" }) });
    expect(client.conversation("s1").get().status).toBe("busy");
  });

  it("stops fetching once the chat is left", async () => {
    const full = chat(200);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], start: 0 })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
    client.connect();
    const socket = FakeSocket.last!;
    socket.open();
    client.watch("s1");
    socket.receive({ type: "snapshot", sessionId: "s1", state: latestOf(full, 40), upToSeq: full.lastSeq });
    client.unwatch("s1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
