import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@renki/protocol";
import { RealtimeClient } from "../src/realtime.js";
import { applyEvent, applyEvents, initialConversation } from "../src/reducer.js";

// Never connected: watch/unwatch only touch local state while offline.
const client = () => new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });

describe("RealtimeClient: stores of chats left behind", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the last few and forgets older ones", async () => {
    vi.useFakeTimers();
    const c = client();
    const stores = Array.from({ length: 7 }, (_, i) => {
      const store = c.watch(`s${i}`);
      c.unwatch(`s${i}`);
      return store;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.conversation("s0")).not.toBe(stores[0]);
    expect(c.conversation("s1")).not.toBe(stores[1]);
    expect(c.conversation("s6")).toBe(stores[6]);
  });

  it("never forgets a store something is still subscribed to", async () => {
    vi.useFakeTimers();
    const c = client();
    const held = c.watch("held");
    const off = held.subscribe(() => {});
    c.unwatch("held");
    for (let i = 0; i < 6; i++) {
      c.watch(`s${i}`);
      c.unwatch(`s${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(c.conversation("held")).toBe(held);
    off();
  });

  it("doesn't count a chat that was opened again", async () => {
    vi.useFakeTimers();
    const c = client();
    const back = c.watch("back");
    c.unwatch("back");
    await vi.advanceTimersByTimeAsync(0);
    c.watch("back");
    for (let i = 0; i < 6; i++) {
      c.watch(`s${i}`);
      c.unwatch(`s${i}`);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(c.conversation("back")).toBe(back);
  });
});

describe("reducer: agent progress", () => {
  const ev = (seq: number, payload: Record<string, unknown>) => ({ seq, sessionId: "s1", ts: 1000 + seq, ...payload }) as SessionEvent;
  const turn = (seq: number, turnId: string, toolUseId: string) => [
    ev(seq, { kind: "turn_started", turnId, promptId: `p${seq}`, trigger: "prompt" }),
    ev(seq + 1, { kind: "assistant_block", turnId, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId, toolName: "Agent", toolInput: {} }),
  ];
  const usage = (tokens: number) => ({ tokens, toolUses: 1, durationMs: 10 });

  it("rebuilds only the turn holding that agent", () => {
    const s = applyEvents(initialConversation("s1"), [...turn(0, "t1", "a1"), ...turn(2, "t2", "a2")]);
    const next = applyEvent(s, ev(4, { kind: "agent_progress", toolUseId: "a2", usage: usage(5) }));
    expect(next.timeline[0]).toBe(s.timeline[0]);
    expect(next.timeline[1]).not.toBe(s.timeline[1]);
  });

  it("changes nothing when the report is stale", () => {
    let s = applyEvents(initialConversation("s1"), turn(0, "t1", "a1"));
    s = applyEvent(s, ev(2, { kind: "agent_progress", toolUseId: "a1", usage: usage(50) }));
    const next = applyEvent(s, ev(3, { kind: "agent_progress", toolUseId: "a1", usage: usage(10) }));
    expect(next.timeline).toBe(s.timeline);
  });
});
