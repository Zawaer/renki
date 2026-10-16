import type { SessionEvent } from "@renki/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSendingPrompt,
  applyEvent,
  applyEvents,
  dropSendingPrompt,
  initialConversation,
  restoreBlockGaps,
  timelineWithSending,
  type ConversationState,
} from "../src/reducer.js";
import { RealtimeClient } from "../src/realtime.js";

const ev = (seq: number, payload: Record<string, unknown>) => ({ seq, sessionId: "s1", ts: 1000, ...payload }) as SessionEvent;
const idle = () => applyEvents(initialConversation("s1"), [ev(0, { kind: "status_changed", status: "idle" })]);
const sending = (promptId: string, text = "hi") => ({ promptId, deviceId: "d1", text, at: 5 });

describe("reducer: local echo", () => {
  it("shows a sent prompt after the real timeline, as an ordinary prompt row", () => {
    const s = addSendingPrompt(idle(), sending("p1", "hello there"));
    const rows = timelineWithSending(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "prompt", promptId: "p1", text: "hello there", deviceId: "d1" });
    expect(s.timeline).toHaveLength(0); // the real timeline is untouched
  });

  it("is replaced, not duplicated, when the daemon confirms — at the same position", () => {
    const echoed = addSendingPrompt(idle(), sending("p1"));
    const before = timelineWithSending(echoed);
    const confirmed = applyEvent(echoed, ev(1, { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "hi" }));
    expect(confirmed.sendingPrompts).toEqual([]);
    const after = timelineWithSending(confirmed);
    expect(after).toHaveLength(1);
    expect(after.findIndex((i) => i.type === "prompt")).toBe(before.findIndex((i) => i.type === "prompt"));
  });

  it("hands over to the queue when the session was busy, with no leftover bubble", () => {
    const echoed = addSendingPrompt(idle(), sending("p2", "later"));
    const queued = applyEvent(echoed, ev(1, { kind: "prompt_queued", promptId: "p2", deviceId: "d1", text: "later" }));
    expect(queued.sendingPrompts).toEqual([]);
    expect(queued.queuedPrompts.map((q) => q.promptId)).toEqual(["p2"]);
    expect(timelineWithSending(queued).filter((i) => i.type === "prompt")).toHaveLength(0);
  });

  it("keeps several in send order, and only confirms the one that arrived", () => {
    let s = addSendingPrompt(addSendingPrompt(idle(), sending("a", "one")), sending("b", "two"));
    expect(timelineWithSending(s).map((i) => (i.type === "prompt" ? i.text : "?"))).toEqual(["one", "two"]);
    s = applyEvent(s, ev(1, { kind: "prompt_submitted", promptId: "a", deviceId: "d1", text: "one" }));
    expect(s.sendingPrompts.map((p) => p.promptId)).toEqual(["b"]);
    expect(timelineWithSending(s).map((i) => (i.type === "prompt" ? i.text : "?"))).toEqual(["one", "two"]);
  });

  it("ignores a repeat of the same id, and dropping an unknown id changes nothing", () => {
    const s = addSendingPrompt(idle(), sending("p1"));
    expect(addSendingPrompt(s, sending("p1"))).toBe(s);
    expect(dropSendingPrompt(s, "nope")).toBe(s);
    expect(dropSendingPrompt(s, "p1").sendingPrompts).toEqual([]);
  });

  it("never survives a trip through the cache, and a pre-existing cache without the field still works", () => {
    const s = addSendingPrompt(idle(), sending("p1"));
    expect(restoreBlockGaps(s).sendingPrompts).toEqual([]);
    const legacy = { ...idle() } as Partial<ConversationState>;
    delete legacy.sendingPrompts;
    expect(timelineWithSending(legacy as ConversationState)).toEqual([]);
    expect(() => applyEvent(legacy as ConversationState, ev(1, { kind: "prompt_submitted", promptId: "x", deviceId: "d", text: "t" }))).not.toThrow();
  });
});

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

function connect() {
  const client = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
  client.connect();
  const socket = FakeSocket.last!;
  socket.open();
  return { client, socket };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RealtimeClient: local echo", () => {
  it("shows the message the instant it is sent, before any reply from the daemon", () => {
    const { client, socket } = connect();
    const promptId = client.submitPrompt("s1", "hello");
    const conv = client.conversation("s1").get();
    expect(timelineWithSending(conv).some((i) => i.type === "prompt" && i.promptId === promptId && i.text === "hello")).toBe(true);
    expect(socket.sent.some((m) => m.type === "submit_prompt" && m.promptId === promptId)).toBe(true);
  });

  it("clears when the daemon confirms it", () => {
    const { client, socket } = connect();
    const promptId = client.submitPrompt("s1", "hello");
    socket.receive({ type: "event", event: ev(0, { kind: "prompt_submitted", promptId, deviceId: "d1", text: "hello" }) });
    const conv = client.conversation("s1").get();
    expect(conv.sendingPrompts).toEqual([]);
    expect(conv.timeline.filter((i) => i.type === "prompt")).toHaveLength(1);
  });

  it("shows nothing for a message that could not be sent because the socket is closed", () => {
    const { client, socket } = connect();
    socket.readyState = 3;
    client.submitPrompt("s1", "lost");
    expect(client.conversation("s1").get().sendingPrompts).toEqual([]);
    expect(socket.sent.some((m) => m.type === "submit_prompt")).toBe(false);
  });

  it("takes the echo back when the daemon refuses that prompt", () => {
    const { client, socket } = connect();
    const promptId = client.submitPrompt("s1", "nope");
    socket.receive({ type: "error", code: "not_controller", message: "no", ref: promptId });
    expect(client.conversation("s1").get().sendingPrompts).toEqual([]);
  });

  it("takes the echo back when the connection drops", () => {
    const { client, socket } = connect();
    client.submitPrompt("s1", "hello");
    socket.onclose?.();
    expect(client.conversation("s1").get().sendingPrompts).toEqual([]);
  });

  it("takes the echo back if nothing ever confirms it", () => {
    vi.useFakeTimers();
    const { client } = connect();
    client.submitPrompt("s1", "hello");
    vi.advanceTimersByTime(29_000);
    expect(client.conversation("s1").get().sendingPrompts).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(client.conversation("s1").get().sendingPrompts).toEqual([]);
  });
});
