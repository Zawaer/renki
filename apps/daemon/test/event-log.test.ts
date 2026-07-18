import type { SessionEvent } from "@crc/protocol";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events/log.js";
import { makeTestDb } from "./helpers.js";

/**
 * The EventLog is the daemon's source of truth. These tests pin the properties
 * the whole no-staleness design leans on: seqs are monotonic and per-session,
 * read(afterSeq) returns exactly the missed tail, and the replay-then-live
 * handoff (the discipline in server/connection.ts) loses and doubles nothing.
 */

describe("append + seq", () => {
  it("stamps monotonically increasing seqs starting at 0", () => {
    const log = new EventLog(makeTestDb());
    const a = log.append("s1", { kind: "status_changed", status: "idle" });
    const b = log.append("s1", { kind: "status_changed", status: "busy" });
    const c = log.append("s1", { kind: "status_changed", status: "idle" });
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(a.sessionId).toBe("s1");
    expect(typeof a.ts).toBe("number");
  });

  it("keeps seqs independent per session", () => {
    const log = new EventLog(makeTestDb());
    expect(log.append("s1", { kind: "status_changed", status: "idle" }).seq).toBe(0);
    expect(log.append("s2", { kind: "status_changed", status: "idle" }).seq).toBe(0);
    expect(log.append("s1", { kind: "status_changed", status: "busy" }).seq).toBe(1);
    expect(log.append("s2", { kind: "status_changed", status: "busy" }).seq).toBe(1);
  });

  it("head() reports the last seq, or -1 for an untouched session", () => {
    const log = new EventLog(makeTestDb());
    expect(log.head("nope")).toBe(-1);
    log.append("s1", { kind: "status_changed", status: "idle" });
    log.append("s1", { kind: "status_changed", status: "busy" });
    expect(log.head("s1")).toBe(1);
  });
});

describe("read", () => {
  it("returns only events strictly after afterSeq, in order", () => {
    const log = new EventLog(makeTestDb());
    for (const status of ["idle", "busy", "idle", "error"] as const) {
      log.append("s1", { kind: "status_changed", status });
    }
    const all = log.read("s1");
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    const tail = log.read("s1", 1);
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
    expect(log.read("s1", 3)).toEqual([]);
  });

  it("round-trips the payload faithfully through JSON storage", () => {
    const log = new EventLog(makeTestDb());
    log.append("s1", {
      kind: "assistant_block",
      turnId: "t1",
      blockIndex: 2,
      blockKind: "tool_use",
      text: null,
      toolUseId: "tu_1",
      toolName: "Edit",
      toolInput: { file: "a.ts", nested: { n: 1 } },
    });
    const [evt] = log.read("s1") as [Extract<SessionEvent, { kind: "assistant_block" }>];
    expect(evt.kind).toBe("assistant_block");
    expect(evt.toolInput).toEqual({ file: "a.ts", nested: { n: 1 } });
    expect(evt.toolUseId).toBe("tu_1");
  });
});

describe("subscribe", () => {
  it("delivers live events and stops after unsubscribe", () => {
    const log = new EventLog(makeTestDb());
    const seen: number[] = [];
    const off = log.subscribe("s1", (e) => seen.push(e.seq));

    log.append("s1", { kind: "status_changed", status: "idle" });
    log.append("s1", { kind: "status_changed", status: "busy" });
    off();
    log.append("s1", { kind: "status_changed", status: "idle" });

    expect(seen).toEqual([0, 1]);
  });

  it("does not deliver another session's events to a subscriber", () => {
    const log = new EventLog(makeTestDb());
    const seen: string[] = [];
    log.subscribe("s1", (e) => seen.push(e.sessionId));
    log.append("s2", { kind: "status_changed", status: "idle" });
    expect(seen).toEqual([]);
  });

  it("onAny observes every session's events", () => {
    const log = new EventLog(makeTestDb());
    const seen: string[] = [];
    log.onAny((e) => seen.push(e.sessionId));
    log.append("s1", { kind: "status_changed", status: "idle" });
    log.append("s2", { kind: "status_changed", status: "idle" });
    expect(seen).toEqual(["s1", "s2"]);
  });
});

describe("restart", () => {
  it("a fresh EventLog on the same db continues the seq from stored history", () => {
    const db = makeTestDb();
    const first = new EventLog(db);
    first.append("s1", { kind: "status_changed", status: "idle" });
    first.append("s1", { kind: "status_changed", status: "busy" });

    // Simulate a daemon restart: brand-new EventLog, same underlying rows.
    const rebooted = new EventLog(db);
    expect(rebooted.head("s1")).toBe(1);
    expect(rebooted.append("s1", { kind: "status_changed", status: "idle" }).seq).toBe(2);
  });
});

describe("replay-then-live handoff (the connection.ts discipline)", () => {
  it("merges backlog + buffered-live events with no gap and no duplicate", () => {
    const log = new EventLog(makeTestDb());
    // Backlog the client already knows nothing about.
    log.append("s1", { kind: "status_changed", status: "idle" });
    log.append("s1", { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "go" });

    // Client subscribes: attach a buffering listener FIRST...
    let buffer: SessionEvent[] | null = [];
    const delivered: number[] = [];
    const off = log.subscribe("s1", (e) => {
      if (buffer) buffer.push(e);
      else delivered.push(e.seq);
    });

    // ...an event lands in the tiny window between subscribe and read...
    log.append("s1", { kind: "status_changed", status: "busy" });

    // ...then read the backlog and flush the buffer, de-duping on seq.
    const replay = log.read("s1", -1);
    const upTo = replay.length > 0 ? replay[replay.length - 1]!.seq : -1;
    for (const seq of replay.map((e) => e.seq)) delivered.push(seq);
    const buffered = buffer!;
    buffer = null;
    for (const e of buffered) if (e.seq > upTo) delivered.push(e.seq);

    // A further live event now passes straight through.
    log.append("s1", { kind: "status_changed", status: "idle" });
    off();

    // Contiguous 0..3, each exactly once — nothing lost, nothing doubled.
    expect(delivered).toEqual([0, 1, 2, 3]);
    expect(new Set(delivered).size).toBe(delivered.length);
  });
});
