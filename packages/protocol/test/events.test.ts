import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  EventPayload,
  ServerMessage,
  SessionEvent,
  type EventKind,
} from "../src/index.js";

/**
 * The protocol package IS the contract between daemon and every client. If a
 * schema drifts, these round-trips fail loudly here rather than as a mystery on
 * the wire. We assert every event kind validates, that the stored envelope shape
 * holds, and that the discriminated unions reject malformed messages.
 */

/** One valid payload per event kind — the exhaustive wire surface for v1. */
const SAMPLES: Record<EventKind, unknown> = {
  session_created: { kind: "session_created", repoId: "r1", repoName: "acme", baseBranch: "main", branch: "crc/ab", worktreePath: "/wt" },
  status_changed: { kind: "status_changed", status: "idle" },
  control_changed: { kind: "control_changed", controller: "d1", controllerName: "Mac" },
  prompt_submitted: { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "hi" },
  assistant_delta: { kind: "assistant_delta", turnId: "t1", blockIndex: 0, blockKind: "text", text: "hey" },
  assistant_block: { kind: "assistant_block", turnId: "t1", blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu", toolName: "Edit", toolInput: { a: 1 } },
  tool_result: { kind: "tool_result", turnId: "t1", toolUseId: "tu", ok: true, summary: "done" },
  permission_request: { kind: "permission_request", requestId: "req", turnId: "t1", toolName: "Bash", toolInput: {} },
  permission_resolved: { kind: "permission_resolved", requestId: "req", decision: "allow", byDeviceId: null },
  turn_result: { kind: "turn_result", turnId: "t1", promptId: "p1", ok: true, costUsd: 0.01, durationMs: 10, errorMessage: null },
  error: { kind: "error", message: "boom", code: null },
  notice: { kind: "notice", text: "switched", level: "info" },
};

describe("EventPayload", () => {
  it("validates every event kind", () => {
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      expect(EventPayload.safeParse(sample).success, kind).toBe(true);
    }
  });

  it("covers the whole EventKind union (no kind left untested)", () => {
    // If a new payload is added without a sample here, this fails.
    const missing = EventPayload.options
      .map((o) => o.shape.kind.value)
      .filter((k) => !(k in SAMPLES));
    expect(missing).toEqual([]);
  });

  it("rejects an unknown kind and a malformed payload", () => {
    expect(EventPayload.safeParse({ kind: "nope" }).success).toBe(false);
    expect(EventPayload.safeParse({ kind: "status_changed", status: "flying" }).success).toBe(false);
  });
});

describe("SessionEvent (envelope + payload)", () => {
  it("round-trips a stored event through JSON", () => {
    const stored = { seq: 7, sessionId: "s1", ts: 123, ...(SAMPLES.assistant_block as object) };
    const parsed = SessionEvent.parse(JSON.parse(JSON.stringify(stored)));
    expect(parsed).toMatchObject({ seq: 7, sessionId: "s1", kind: "assistant_block" });
  });

  it("requires the envelope fields", () => {
    expect(SessionEvent.safeParse(SAMPLES.status_changed).success).toBe(false); // no seq/sessionId/ts
    expect(SessionEvent.safeParse({ seq: -1, sessionId: "s1", ts: 1, kind: "status_changed", status: "idle" }).success).toBe(false); // seq must be >= 0
  });
});

describe("WS messages", () => {
  it("accepts a well-formed subscribe and rejects a bad lastSeq", () => {
    expect(ClientMessage.safeParse({ type: "subscribe", sessionId: "s1", lastSeq: -1 }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: "subscribe", sessionId: "s1", lastSeq: -2 }).success).toBe(false);
  });

  it("rejects an empty submit_prompt", () => {
    expect(ClientMessage.safeParse({ type: "submit_prompt", sessionId: "s1", promptId: "p1", text: "" }).success).toBe(false);
  });

  it("validates a replay server message carrying events", () => {
    const msg = {
      type: "replay",
      sessionId: "s1",
      upToSeq: 1,
      events: [{ seq: 0, sessionId: "s1", ts: 1, ...(SAMPLES.status_changed as object) }],
    };
    expect(ServerMessage.safeParse(msg).success).toBe(true);
  });
});
