import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "../src/server/permissions.js";

const TIMEOUT_MS = 60_000;

function fakeRequest(requestId: string, overrides: Partial<{ turnId: string; toolName: string; toolInput: unknown }> = {}) {
  return {
    requestId,
    turnId: overrides.turnId ?? "t_1",
    toolName: overrides.toolName ?? "Bash",
    toolInput: overrides.toolInput ?? { command: "ls" },
    signal: new AbortController().signal,
  };
}

describe("PermissionBroker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks a pending request as soon as the resolver is invoked", () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    const resolve = broker.resolverFor("s_1");
    expect(broker.has("r_1")).toBe(false);
    void resolve(fakeRequest("r_1"));
    expect(broker.has("r_1")).toBe(true);
    expect(broker.sessionOf("r_1")).toBe("s_1");
  });

  it("settles the promise with the controller's decision and clears the pending entry", async () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    const promise = broker.resolverFor("s_1")(fakeRequest("r_1"));

    const matched = broker.answer("r_1", "allow", "d_phone");
    expect(matched).toBe(true);
    await expect(promise).resolves.toEqual({ decision: "allow", byDeviceId: "d_phone" });
    expect(broker.has("r_1")).toBe(false);
  });

  it("returns false for an unknown request id, without throwing", () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    expect(broker.answer("nonexistent", "deny", "d_phone")).toBe(false);
  });

  it("returns false for a second answer to an already-settled request", async () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    const promise = broker.resolverFor("s_1")(fakeRequest("r_1"));
    expect(broker.answer("r_1", "allow", "d_phone")).toBe(true);
    expect(broker.answer("r_1", "deny", "d_other")).toBe(false);
    // The first answer is the one that sticks — a late/duplicate second
    // answer must not clobber it.
    await expect(promise).resolves.toEqual({ decision: "allow", byDeviceId: "d_phone" });
  });

  it("clears the timeout on answer, so it never later fires a stray auto-deny", async () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    const promise = broker.resolverFor("s_1")(fakeRequest("r_1"));
    broker.answer("r_1", "allow", "d_phone");

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1000);
    // Still the controller's original decision — not overwritten by a
    // leaked timer settling it a second time (which would throw/no-op on
    // an already-settled promise, but the pending map staying clear proves
    // the timer was actually cleared, not just harmlessly racing).
    await expect(promise).resolves.toEqual({ decision: "allow", byDeviceId: "d_phone" });
    expect(broker.has("r_1")).toBe(false);
  });

  it("fail-safe: auto-denies once the timeout elapses with no answer", async () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    const promise = broker.resolverFor("s_1")(fakeRequest("r_1"));
    expect(broker.has("r_1")).toBe(true);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(promise).resolves.toEqual({ decision: "deny", byDeviceId: null });
    expect(broker.has("r_1")).toBe(false);
  });

  it("does not auto-deny early — before the timeout elapses, the request is still pending", async () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    broker.resolverFor("s_1")(fakeRequest("r_1")).catch(() => {});
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(broker.has("r_1")).toBe(true);
  });

  it("tracks multiple pending requests across different sessions independently", async () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    const p1 = broker.resolverFor("s_1")(fakeRequest("r_1"));
    const p2 = broker.resolverFor("s_2")(fakeRequest("r_2"));

    expect(broker.sessionOf("r_1")).toBe("s_1");
    expect(broker.sessionOf("r_2")).toBe("s_2");

    broker.answer("r_1", "deny", "d_web");
    expect(broker.has("r_1")).toBe(false);
    expect(broker.has("r_2")).toBe(true); // answering one doesn't touch the other

    await expect(p1).resolves.toEqual({ decision: "deny", byDeviceId: "d_web" });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(p2).resolves.toEqual({ decision: "deny", byDeviceId: null });
  });

  it("sessionOf returns undefined for a request that was never registered or already settled", () => {
    const broker = new PermissionBroker(TIMEOUT_MS);
    expect(broker.sessionOf("never-existed")).toBeUndefined();
    broker.resolverFor("s_1")(fakeRequest("r_1")).catch(() => {});
    broker.answer("r_1", "allow", "d_phone");
    expect(broker.sessionOf("r_1")).toBeUndefined();
  });
});
