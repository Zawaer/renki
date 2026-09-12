import type { EventPayload, SessionEvent } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyEvents,
  initialConversation,
  turnTriggerLabel,
  type ConversationState,
  type TimelineItem,
} from "../src/reducer.js";

/**
 * The reducer is the load-bearing claim of the whole project: feed the same
 * ordered events through it — whether as a cold replay or a live stream — and
 * every client lands on the same state. These tests pin that property down
 * (determinism + replay==live) alongside the per-event folding rules.
 */

const SID = "s_test";

/** Stamp a list of payloads into SessionEvents with sequential seqs from 0. */
function stream(...payloads: EventPayload[]): SessionEvent[] {
  return payloads.map((p, i) => ({ seq: i, sessionId: SID, ts: 1000 + i, ...p }) as SessionEvent);
}

function fold(events: SessionEvent[]): ConversationState {
  return applyEvents(initialConversation(SID), events);
}

// A realistic single-prompt turn: create → idle → take control → prompt →
// think → text (streamed then finalized) → a gated tool → approve → result →
// turn done → back to idle.
const TURN = "t_1";
function scriptedStream(): SessionEvent[] {
  return stream(
    { kind: "session_created", repoId: "r1", repoName: "acme", baseBranch: "main", branch: "crc/ab12", worktreePath: "/wt/s_test" },
    { kind: "status_changed", status: "idle" },
    { kind: "control_changed", controller: "d_phone", controllerName: "Phone" },
    { kind: "status_changed", status: "busy" },
    { kind: "prompt_submitted", promptId: "p1", deviceId: "d_phone", text: "fix the bug" },
    { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "thinking", text: "Let me " },
    { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "thinking", text: "look…" },
    { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "thinking", text: "Let me look…", toolUseId: null, toolName: null, toolInput: null },
    { kind: "assistant_delta", turnId: TURN, blockIndex: 1, blockKind: "text", text: "I'll " },
    { kind: "assistant_delta", turnId: TURN, blockIndex: 1, blockKind: "text", text: "edit it." },
    { kind: "assistant_block", turnId: TURN, blockIndex: 1, blockKind: "text", text: "I'll edit it.", toolUseId: null, toolName: null, toolInput: null },
    { kind: "assistant_block", turnId: TURN, blockIndex: 2, blockKind: "tool_use", text: null, toolUseId: "tu_1", toolName: "Edit", toolInput: { file: "a.ts" } },
    { kind: "permission_request", requestId: "req_1", turnId: TURN, toolName: "Edit", toolInput: { file: "a.ts" } },
    { kind: "permission_resolved", requestId: "req_1", decision: "allow", byDeviceId: "d_phone" },
    { kind: "tool_result", turnId: TURN, toolUseId: "tu_1", ok: true, summary: "edited a.ts" },
    { kind: "turn_result", turnId: TURN, promptId: "p1", ok: true, costUsd: 0.012, durationMs: 3400, errorMessage: null, inputTokens: 1200, outputTokens: 340 },
    { kind: "status_changed", status: "idle" },
  );
}

describe("initialConversation", () => {
  it("starts empty with lastSeq -1", () => {
    const s = initialConversation(SID);
    expect(s).toEqual({
      sessionId: SID,
      status: null,
      controller: null,
      controllerName: null,
      repoName: null,
      branch: null,
      timeline: [],
      pending: [],
      queuedPrompts: [],
      context: null,
      model: null,
      // Session-owned composer settings; null until the daemon pushes them.
      composer: null,
      lastSeq: -1,
    });
  });
});

describe("per-event folding", () => {
  it("session_created records repo + branch", () => {
    const s = fold(stream({ kind: "session_created", repoId: "r1", repoName: "acme", baseBranch: "main", branch: "crc/ab12", worktreePath: "/wt" }));
    expect(s.repoName).toBe("acme");
    expect(s.branch).toBe("crc/ab12");
  });

  it("status_changed sets status", () => {
    const s = fold(stream({ kind: "status_changed", status: "busy" }));
    expect(s.status).toBe("busy");
  });

  it("control_changed sets and clears the controller", () => {
    const taken = fold(stream({ kind: "control_changed", controller: "d1", controllerName: "Mac" }));
    expect(taken.controller).toBe("d1");
    expect(taken.controllerName).toBe("Mac");
    const released = fold(stream(
      { kind: "control_changed", controller: "d1", controllerName: "Mac" },
      { kind: "control_changed", controller: null, controllerName: null },
    ));
    expect(released.controller).toBeNull();
    expect(released.controllerName).toBeNull();
  });

  it("prompt_submitted appends a prompt item", () => {
    const s = fold(stream({ kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "hi" }));
    expect(s.timeline).toEqual([{ type: "prompt", promptId: "p1", deviceId: "d1", text: "hi" }]);
  });

  it("prompt_submitted carries attachments through onto the timeline item", () => {
    const attachments = [{ name: "shot.png", mediaType: "image/png" as const, data: "cGFrZQ==" }];
    const s = fold(stream({ kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "what is this?", attachments }));
    expect(s.timeline).toEqual([{ type: "prompt", promptId: "p1", deviceId: "d1", text: "what is this?", attachments }]);
  });

  it("prompt_queued lands in queuedPrompts, not timeline", () => {
    const s = fold(stream({ kind: "prompt_queued", promptId: "p2", deviceId: "d1", text: "queued question" }));
    expect(s.timeline).toEqual([]);
    expect(s.queuedPrompts).toEqual([{ promptId: "p2", deviceId: "d1", text: "queued question" }]);
  });

  it("prompt_submitted moves a queued prompt out of queuedPrompts and into timeline", () => {
    const s = fold(stream(
      { kind: "prompt_queued", promptId: "p2", deviceId: "d1", text: "queued question" },
      { kind: "prompt_submitted", promptId: "p2", deviceId: "d1", text: "queued question" },
    ));
    expect(s.queuedPrompts).toEqual([]);
    expect(s.timeline).toEqual([{ type: "prompt", promptId: "p2", deviceId: "d1", text: "queued question" }]);
  });

  it("keeps every prompt/answer pair adjacent in timeline even when a follow-up is queued before the prior turn finishes", () => {
    // Regression case: a fast follow-up used to get an eager timeline bubble
    // ahead of the turn it was replying to, permanently desyncing every
    // prompt/answer pair after it. Queued prompts must stay out of `timeline`
    // until their own turn actually starts.
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "2348594353+403" },
      // The user types a follow-up before p1's answer streams back at all.
      { kind: "prompt_queued", promptId: "p2", deviceId: "d1", text: "2423+2" },
      { kind: "assistant_block", turnId: "t1", blockIndex: 0, blockKind: "text", text: "2348594756", toolUseId: null, toolName: null, toolInput: null },
      { kind: "turn_result", turnId: "t1", promptId: "p1", ok: true, costUsd: 0.01, durationMs: 100, errorMessage: null, inputTokens: 1, outputTokens: 1 },
      { kind: "prompt_submitted", promptId: "p2", deviceId: "d1", text: "2423+2" },
      { kind: "assistant_block", turnId: "t2", blockIndex: 0, blockKind: "text", text: "2425", toolUseId: null, toolName: null, toolInput: null },
      { kind: "turn_result", turnId: "t2", promptId: "p2", ok: true, costUsd: 0.01, durationMs: 100, errorMessage: null, inputTokens: 1, outputTokens: 1 },
    ));
    expect(s.queuedPrompts).toEqual([]);
    expect(s.timeline.map((it) => (it.type === "prompt" ? it.text : (it as any).turn.blocks[0].text))).toEqual([
      "2348594353+403",
      "2348594756",
      "2423+2",
      "2425",
    ]);
  });

  it("assistant_delta accumulates text across chunks within a block", () => {
    const s = fold(stream(
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "text", text: "Hel" },
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "text", text: "lo" },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.blocks[0]).toEqual({ kind: "text", text: "Hello", startedAtMs: 1000, endedAtMs: null });
    expect(turn.status).toBe("running");
  });

  it("assistant_block's canonical text supersedes the streamed accumulation", () => {
    const s = fold(stream(
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "text", text: "par" },
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "text", text: "tial" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "text", text: "final canonical", toolUseId: null, toolName: null, toolInput: null },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.blocks[0]).toEqual({ kind: "text", text: "final canonical", startedAtMs: 1000, endedAtMs: 1002 });
  });

  it("a block's endedAtMs is back-filled from the next block's first delta, not its own (never-sent) close event", () => {
    const s = fold(stream(
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "thinking", text: "hm" },
      { kind: "assistant_delta", turnId: TURN, blockIndex: 1, blockKind: "text", text: "ok" },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.blocks[0]).toEqual({ kind: "thinking", text: "hm", startedAtMs: 1000, endedAtMs: 1001 });
    expect(turn.blocks[1]).toEqual({ kind: "text", text: "ok", startedAtMs: 1001, endedAtMs: null });
  });

  it("a block already closed by its own assistant_block isn't reopened when the next block starts", () => {
    const s = fold(stream(
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "thinking", text: "hm" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "thinking", text: "hm", toolUseId: null, toolName: null, toolInput: null },
      { kind: "assistant_delta", turnId: TURN, blockIndex: 1, blockKind: "text", text: "ok" },
    ));
    const turn = (s.timeline[0] as any).turn;
    // Closed by its own assistant_block (ts 1001) — the later block-1 delta (ts 1002) must not overwrite it.
    expect(turn.blocks[0]).toEqual({ kind: "thinking", text: "hm", startedAtMs: 1000, endedAtMs: 1001 });
  });

  it("tool_use block plus tool_result attaches the result by toolUseId", () => {
    const s = fold(stream(
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu_1", toolName: "Bash", toolInput: { cmd: "ls" } },
      { kind: "tool_result", turnId: TURN, toolUseId: "tu_1", ok: true, summary: "a.ts b.ts" },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.blocks[0]).toEqual({
      kind: "tool_use",
      toolUseId: "tu_1",
      toolName: "Bash",
      toolInput: { cmd: "ls" },
      result: { ok: true, summary: "a.ts b.ts" },
    });
  });

  it("a tool_result for an unknown toolUseId attaches to nothing", () => {
    const s = fold(stream(
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu_1", toolName: "Bash", toolInput: {} },
      { kind: "tool_result", turnId: TURN, toolUseId: "tu_OTHER", ok: false, summary: "nope" },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.blocks[0].result).toBeNull();
  });

  it("permission_request adds to pending; permission_resolved removes it", () => {
    const requested = fold(stream(
      { kind: "permission_request", requestId: "req_1", turnId: TURN, toolName: "Edit", toolInput: { f: 1 } },
    ));
    expect(requested.pending).toEqual([{ requestId: "req_1", turnId: TURN, toolName: "Edit", toolInput: { f: 1 } }]);

    const resolved = applyEvent(requested, {
      seq: 1, sessionId: SID, ts: 2,
      kind: "permission_resolved", requestId: "req_1", decision: "deny", byDeviceId: "d1",
    } as SessionEvent);
    expect(resolved.pending).toEqual([]);
  });

  it("resolving an unknown request leaves pending untouched", () => {
    const s = fold(stream(
      { kind: "permission_request", requestId: "req_1", turnId: TURN, toolName: "Edit", toolInput: {} },
      { kind: "permission_resolved", requestId: "req_OTHER", decision: "allow", byDeviceId: null },
    ));
    expect(s.pending.map((p) => p.requestId)).toEqual(["req_1"]);
  });

  it("turn_result marks the turn done with cost + duration + token usage", () => {
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "go" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "text", text: "done", toolUseId: null, toolName: null, toolInput: null },
      { kind: "turn_result", turnId: TURN, promptId: "p1", ok: true, costUsd: 0.5, durationMs: 1200, errorMessage: null, inputTokens: 800, outputTokens: 120 },
    ));
    const turn = (s.timeline[1] as any).turn;
    expect(turn.status).toBe("done");
    expect(turn.costUsd).toBe(0.5);
    expect(turn.durationMs).toBe(1200);
    expect(turn.promptId).toBe("p1");
    expect(turn.inputTokens).toBe(800);
    expect(turn.outputTokens).toBe(120);
  });

  it("a failed turn_result marks the turn errored and carries the message", () => {
    const s = fold(stream(
      { kind: "turn_result", turnId: TURN, promptId: "p1", ok: false, costUsd: null, durationMs: null, errorMessage: "boom", inputTokens: null, outputTokens: null },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.status).toBe("error");
    expect(turn.errorMessage).toBe("boom");
    expect(turn.inputTokens).toBeNull();
    expect(turn.outputTokens).toBeNull();
    expect(turn.interrupted).toBe(false);
  });

  it("an interrupted turn_result (the stop button) flags the turn as interrupted", () => {
    const s = fold(stream(
      {
        kind: "turn_result",
        turnId: TURN,
        promptId: "p1",
        ok: false,
        costUsd: null,
        durationMs: null,
        errorMessage: "Stopped by controller.",
        inputTokens: null,
        outputTokens: null,
        interrupted: true,
      },
    ));
    const turn = (s.timeline[0] as any).turn;
    expect(turn.status).toBe("error");
    expect(turn.interrupted).toBe(true);
  });

  it("a rate-limit retry (same promptId, new turnId) drops the failed attempt it replaced", () => {
    const RETRY = "t_2";
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "go" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "text", text: "partial answer", toolUseId: null, toolName: null, toolInput: null },
      { kind: "turn_result", turnId: TURN, promptId: "p1", ok: false, costUsd: null, durationMs: null, errorMessage: "usage limit", inputTokens: null, outputTokens: null },
      { kind: "notice", text: "Usage limit hit — switching account…", level: "warn" },
      { kind: "assistant_block", turnId: RETRY, blockIndex: 0, blockKind: "text", text: "final answer", toolUseId: null, toolName: null, toolInput: null },
      { kind: "turn_result", turnId: RETRY, promptId: "p1", ok: true, costUsd: 0.1, durationMs: 900, errorMessage: null, inputTokens: 10, outputTokens: 5 },
    ));
    const turns = s.timeline.filter((it) => it.type === "turn").map((it) => (it as any).turn);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe(RETRY);
    expect(turns[0].status).toBe("done");
    expect(turns[0].blocks[0].text).toBe("final answer");
  });

  it("if the retry ALSO fails, only the retry's failure is shown (not both)", () => {
    const RETRY = "t_2";
    const s = fold(stream(
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "text", text: "partial", toolUseId: null, toolName: null, toolInput: null },
      { kind: "turn_result", turnId: TURN, promptId: "p1", ok: false, costUsd: null, durationMs: null, errorMessage: "usage limit", inputTokens: null, outputTokens: null },
      { kind: "turn_result", turnId: RETRY, promptId: "p1", ok: false, costUsd: null, durationMs: null, errorMessage: "usage limit again", inputTokens: null, outputTokens: null },
    ));
    const turns = s.timeline.filter((it) => it.type === "turn").map((it) => (it as any).turn);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe(RETRY);
    expect(turns[0].errorMessage).toBe("usage limit again");
  });

  it("notice appends an inline timeline notice", () => {
    const s = fold(stream({ kind: "notice", text: "switched account", level: "warn" }));
    expect(s.timeline).toEqual([{ type: "notice", text: "switched account", level: "warn" }]);
  });

  it("model_changed lands in the timeline where it happened, between the turns it separates", () => {
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "first" },
      { kind: "turn_result", turnId: "t_1", promptId: "p1", ok: true, costUsd: 0.01, durationMs: 10, errorMessage: null, inputTokens: 1, outputTokens: 1 },
      { kind: "model_changed", model: "claude-fable-5-1", previousModel: "claude-opus-5" },
      { kind: "prompt_submitted", promptId: "p2", deviceId: "d1", text: "second" },
    ));
    expect(s.timeline.map((it) => it.type)).toEqual(["prompt", "turn", "model_change", "prompt"]);
    expect(s.timeline[2]).toEqual({ type: "model_change", model: "claude-fable-5-1", previousModel: "claude-opus-5" });
    // What the session is running NOW — separate from any device's picker.
    expect(s.model).toBe("claude-fable-5-1");
  });

  it("tracks the model from a turn's own result, for transcripts recorded before model_changed existed", () => {
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "go" },
      { kind: "turn_result", turnId: "t_1", promptId: "p1", ok: true, costUsd: 0.01, durationMs: 10, errorMessage: null, inputTokens: 1, outputTokens: 1, model: "claude-opus-5" },
    ));
    expect(s.model).toBe("claude-opus-5");
    expect(s.timeline.some((it) => it.type === "model_change")).toBe(false);
  });

  it("background_task attaches to its Task tool_use block even when that block lives in an EARLIER, already-finished turn", () => {
    const T0 = "t_spawn";
    const T1 = "t_later";
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "spin up an agent" },
      { kind: "assistant_block", turnId: T0, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu_agent", toolName: "Agent", toolInput: {} },
      { kind: "turn_result", turnId: T0, promptId: "p1", ok: true, costUsd: 0.01, durationMs: 10, errorMessage: null, inputTokens: 1, outputTokens: 1 },
      // An unrelated later turn is the one whose live query happens to
      // receive the SDK's task_notification — it carries no turnId at all.
      { kind: "prompt_submitted", promptId: "p2", deviceId: "d1", text: "anything else?" },
      { kind: "assistant_block", turnId: T1, blockIndex: 0, blockKind: "text", text: "sure, one sec", toolUseId: null, toolName: null, toolInput: null },
      { kind: "background_task", taskId: "task_1", toolUseId: "tu_agent", status: "completed", summary: "octopus fact delivered" },
    ));
    const turns = s.timeline.filter((it) => it.type === "turn").map((it: any) => it.turn);
    const spawnTurn = turns.find((t) => t.turnId === T0);
    const agentBlock = spawnTurn.blocks.find((b: any) => b.toolUseId === "tu_agent");
    expect(agentBlock.backgroundTask).toEqual({ status: "completed", summary: "octopus fact delivered" });
    // The later turn that happened to carry the notification is untouched.
    const laterTurn = turns.find((t) => t.turnId === T1);
    expect(laterTurn.blocks.every((b: any) => !("backgroundTask" in b) || b.backgroundTask == null)).toBe(true);
  });

  it("background_task falls back to a plain notice when no matching tool_use block exists", () => {
    const s = fold(stream({ kind: "background_task", taskId: "task_1", toolUseId: null, status: "failed", summary: "agent crashed" }));
    expect(s.timeline).toEqual([{ type: "notice", text: "Background task finished: agent crashed", level: "warn" }]);
  });

  it("error events fold nothing into the timeline but still advance lastSeq", () => {
    const s = fold(stream(
      { kind: "status_changed", status: "idle" },
      { kind: "error", message: "spawn failed", code: "ENOENT" },
    ));
    expect(s.timeline).toEqual([]);
    expect(s.lastSeq).toBe(1);
  });

  it("lastSeq tracks the highest seq folded", () => {
    expect(fold(scriptedStream()).lastSeq).toBe(scriptedStream().length - 1);
  });
});

describe("full scripted turn", () => {
  it("produces the expected timeline shape", () => {
    const s = fold(scriptedStream());
    expect(s.status).toBe("idle");
    expect(s.controller).toBe("d_phone");
    expect(s.repoName).toBe("acme");
    expect(s.pending).toEqual([]);
    // prompt item, then the turn item.
    expect(s.timeline[0]).toEqual({ type: "prompt", promptId: "p1", deviceId: "d_phone", text: "fix the bug" });
    const turn = (s.timeline[1] as any).turn;
    expect(turn.status).toBe("done");
    expect(turn.blocks.map((b: any) => b.kind)).toEqual(["thinking", "text", "tool_use"]);
    expect(turn.blocks[0].text).toBe("Let me look…");
    expect(turn.blocks[1].text).toBe("I'll edit it.");
    expect(turn.blocks[2].result).toEqual({ ok: true, summary: "edited a.ts" });
    // Thinking ran from its first delta to its own assistant_block finalization.
    expect(turn.blocks[0].startedAtMs).toBe(1005);
    expect(turn.blocks[0].endedAtMs).toBe(1007);
    expect(turn.inputTokens).toBe(1200);
    expect(turn.outputTokens).toBe(340);
  });
});

describe("determinism", () => {
  it("folding the same events twice yields deeply-equal state", () => {
    const a = fold(scriptedStream());
    const b = fold(scriptedStream());
    expect(a).toEqual(b);
  });
});

describe("replay == live (staleness is impossible)", () => {
  it("splitting the stream at every point and resuming lands on the identical state", () => {
    const events = scriptedStream();
    const whole = fold(events);

    for (let k = 0; k <= events.length; k++) {
      // Client A folds a prefix and remembers its lastSeq.
      const prefix = applyEvents(initialConversation(SID), events.slice(0, k));
      // It reconnects: the server returns "everything after lastSeq" (read()).
      const missed = events.filter((e) => e.seq > prefix.lastSeq);
      const resumed = applyEvents(prefix, missed);
      expect(resumed).toEqual(whole);
    }
  });

  it("a late joiner replaying from seq -1 matches a client that watched live", () => {
    const events = scriptedStream();
    const live = events.reduce(applyEvent, initialConversation(SID));
    const lateJoiner = applyEvents(initialConversation(SID), events);
    expect(lateJoiner).toEqual(live);
  });
});

describe("idempotency (duplicate delivery is a no-op)", () => {
  it("re-applying an already-folded event (seq <= lastSeq) changes nothing", () => {
    const events = scriptedStream();
    const once = fold(events);
    // Simulate a redelivered event — e.g. an overlapping replay from a double
    // subscribe — landing again after the client already folded it.
    const twice = applyEvent(once, events[4]!); // the prompt_submitted event
    expect(twice).toEqual(once);
  });

  it("folding the whole stream twice in a row doesn't duplicate timeline entries", () => {
    const events = scriptedStream();
    const s = applyEvents(applyEvents(initialConversation(SID), events), events);
    expect(s.timeline).toEqual(fold(events).timeline);
  });
});

describe("purity", () => {
  it("applyEvent never mutates the previous state", () => {
    const prev = fold(scriptedStream());
    const snapshot = structuredClone(prev);
    const next = applyEvent(prev, {
      seq: 999, sessionId: SID, ts: 9,
      kind: "notice", text: "later", level: "info",
    } as SessionEvent);
    expect(prev).toEqual(snapshot); // untouched
    expect(next).not.toBe(prev); // new object
    expect(next.timeline).not.toBe(prev.timeline); // new array
  });
});

/**
 * With the Agent SDK's forwardSubagentText on, a Task tool call's own subagent
 * streams its thinking/text/tool-calls tagged with parentToolUseId — these
 * must nest under that Task's tool_use block (`block.subagent.blocks`), not
 * pollute the turn's own top-level blocks, and the Task's own tool_result
 * should flip the subagent to "done".
 */
describe("subagent nesting (forwardSubagentText)", () => {
  function turnOf(s: ConversationState) {
    const item = s.timeline.find((it) => it.type === "turn");
    if (!item || item.type !== "turn") throw new Error("no turn in timeline");
    return item.turn;
  }

  it("routes subagent-tagged deltas/blocks into the Task block's nested subagent.blocks", () => {
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "explore the repo" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu_task", toolName: "Task", toolInput: { description: "Explore" } },
      { kind: "assistant_delta", turnId: TURN, blockIndex: 0, blockKind: "text", text: "Look", parentToolUseId: "tu_task" },
      {
        kind: "assistant_block",
        turnId: TURN,
        blockIndex: 0,
        blockKind: "text",
        text: "Looking around…",
        toolUseId: null,
        toolName: null,
        toolInput: null,
        parentToolUseId: "tu_task",
        subagentType: "Explore",
        taskDescription: "Explore the repo",
      },
    ));

    const turn = turnOf(s);
    expect(turn.blocks).toHaveLength(1); // the subagent's activity did NOT land as a sibling top-level block
    const task = turn.blocks[0]!;
    if (task.kind !== "tool_use") throw new Error("expected tool_use");
    expect(task.toolUseId).toBe("tu_task");
    expect(task.subagent).toMatchObject({
      subagentType: "Explore",
      taskDescription: "Explore the repo",
      status: "running",
    });
    expect(task.subagent!.blocks).toEqual([{ kind: "text", text: "Looking around…", startedAtMs: 1002, endedAtMs: 1003 }]);
  });

  it("marks the subagent done when the Task's own tool_result arrives, and routes a nested tool_result to the right level", () => {
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "explore the repo" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu_task", toolName: "Task", toolInput: {} },
      // The subagent's OWN tool call (e.g. Read) nested one level under the Task.
      {
        kind: "assistant_block",
        turnId: TURN,
        blockIndex: 0,
        blockKind: "tool_use",
        text: null,
        toolUseId: "tu_read",
        toolName: "Read",
        toolInput: { file_path: "/a.ts" },
        parentToolUseId: "tu_task",
      },
      { kind: "tool_result", turnId: TURN, toolUseId: "tu_read", ok: true, summary: "file contents" },
      { kind: "tool_result", turnId: TURN, toolUseId: "tu_task", ok: true, summary: "done exploring" },
    ));

    const task = turnOf(s).blocks[0]!;
    if (task.kind !== "tool_use") throw new Error("expected tool_use");
    expect(task.result).toEqual({ ok: true, summary: "done exploring" });
    expect(task.subagent!.status).toBe("done");

    const nestedRead = task.subagent!.blocks[0]!;
    if (nestedRead.kind !== "tool_use") throw new Error("expected nested tool_use");
    expect(nestedRead.toolUseId).toBe("tu_read");
    expect(nestedRead.result).toEqual({ ok: true, summary: "file contents" }); // routed one level deep, not left null
  });

  it("keeps the main turn's own block indices independent of a subagent's, even interleaved", () => {
    const s = fold(stream(
      { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "go" },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu_task", toolName: "Task", toolInput: {} },
      { kind: "assistant_block", turnId: TURN, blockIndex: 0, blockKind: "text", text: "sub says hi", toolUseId: null, toolName: null, toolInput: null, parentToolUseId: "tu_task" },
      { kind: "tool_result", turnId: TURN, toolUseId: "tu_task", ok: true, summary: "ok" },
      // Main agent's own NEXT top-level block, also at local blockIndex 0 in the
      // raw stream's per-message numbering — runner.ts's globalOffset is what
      // keeps this from colliding with the Task block above; the reducer here
      // just trusts blockIndex as given, so this pins that main-turn blockIndex
      // 1 (assigned by the daemon) lands as its own distinct block.
      { kind: "assistant_block", turnId: TURN, blockIndex: 1, blockKind: "text", text: "Here's what I found.", toolUseId: null, toolName: null, toolInput: null },
    ));

    const turn = turnOf(s);
    expect(turn.blocks).toHaveLength(2);
    expect(turn.blocks[1]).toMatchObject({ kind: "text", text: "Here's what I found." });
    // The subagent's text never leaked into the top level.
    expect(turn.blocks.some((b) => b.kind === "text" && b.text === "sub says hi")).toBe(false);
  });
});

describe("steering + turn_started", () => {
  it("turn_started creates the turn with its trigger and promptId before any block streams", () => {
    const s = fold(stream({ kind: "turn_started", turnId: "t9", promptId: "auto_t9", trigger: "background_task" }));
    expect(s.timeline).toHaveLength(1);
    const item = s.timeline[0] as Extract<TimelineItem, { type: "turn" }>;
    expect(item.turn).toMatchObject({ turnId: "t9", promptId: "auto_t9", trigger: "background_task", status: "running" });
  });

  it("a steered prompt lands INSIDE the running turn, pinned after the block that was current, not on the timeline", () => {
    const s = fold(
      stream(
        { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "long task" },
        { kind: "turn_started", turnId: "t1", promptId: "p1", trigger: "prompt" },
        { kind: "assistant_block", turnId: "t1", blockIndex: 0, blockKind: "tool_use", text: null, toolUseId: "tu1", toolName: "Bash", toolInput: {} },
        { kind: "prompt_submitted", promptId: "p2", deviceId: "d1", text: "also do Y", steered: true },
        { kind: "assistant_block", turnId: "t1", blockIndex: 1, blockKind: "text", text: "did both", toolUseId: null, toolName: null, toolInput: null },
        { kind: "turn_result", turnId: "t1", promptId: "p1", promptIds: ["p1", "p2"], ok: true, costUsd: 0.01, durationMs: 5, errorMessage: null, inputTokens: 1, outputTokens: 1 },
      ),
    );
    expect(s.timeline.map((it) => it.type)).toEqual(["prompt", "turn"]);
    const turn = (s.timeline[1] as Extract<TimelineItem, { type: "turn" }>).turn;
    expect(turn.steeredPrompts).toEqual([{ promptId: "p2", deviceId: "d1", text: "also do Y", attachments: undefined, afterBlockIndex: 0 }]);
    expect(turn.status).toBe("done");
    expect(s.queuedPrompts).toEqual([]);
  });

  it("a prompt flagged steered with no running turn to join falls back to an ordinary timeline prompt", () => {
    const s = fold(stream({ kind: "prompt_submitted", promptId: "p2", deviceId: "d1", text: "hi", steered: true }));
    expect(s.timeline).toEqual([{ type: "prompt", promptId: "p2", deviceId: "d1", text: "hi", attachments: undefined }]);
  });

  it("turnTriggerLabel names unprompted turns and stays silent for prompted/legacy ones", () => {
    const base = (fold(stream({ kind: "turn_started", turnId: "t", promptId: "p", trigger: "prompt" })).timeline[0] as Extract<TimelineItem, { type: "turn" }>).turn;
    expect(turnTriggerLabel(base)).toBeNull();
    expect(turnTriggerLabel({ ...base, trigger: null })).toBeNull();
    expect(turnTriggerLabel({ ...base, trigger: "background_task" })).toMatch(/Background agent finished/);
    expect(turnTriggerLabel({ ...base, trigger: "auto" })).toMatch(/continued/);
  });
});

describe("block timing survives compaction", () => {
  it("takes a thinking block's duration from the daemon's measurement, not from delta timestamps", () => {
    // A replayed session has no assistant_delta events at all — they are
    // compacted away once the block lands — so this is the only timing source.
    const st = fold(
      stream(
        { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "think" },
        { kind: "assistant_block", turnId: "t1", blockIndex: 0, blockKind: "thinking", text: "hmm", toolUseId: null, toolName: null, toolInput: null, durationMs: 4200 },
      ),
    );
    const turn = (st.timeline[1] as Extract<TimelineItem, { type: "turn" }>).turn;
    const block = turn.blocks[0]!;
    if (block.kind === "tool_use") throw new Error("expected a thinking block");
    expect(block.endedAtMs! - block.startedAtMs!).toBe(4200);
  });

  it("falls back to delta timestamps when the daemon sent no measurement", () => {
    const st = fold(
      stream(
        { kind: "assistant_delta", turnId: "t1", blockIndex: 0, blockKind: "thinking", text: "hm" },
        { kind: "assistant_block", turnId: "t1", blockIndex: 0, blockKind: "thinking", text: "hmm", toolUseId: null, toolName: null, toolInput: null },
      ),
    );
    const turn = (st.timeline[0] as Extract<TimelineItem, { type: "turn" }>).turn;
    const block = turn.blocks[0]!;
    if (block.kind === "tool_use") throw new Error("expected a thinking block");
    // stream() stamps ts 1000 + index, so the delta and the block are 1ms apart.
    expect(block.startedAtMs).toBe(1000);
    expect(block.endedAtMs).toBe(1001);
  });
});

describe("context usage", () => {
  it("keeps the latest report and nothing before the daemon has sent one", () => {
    expect(fold(stream({ kind: "status_changed", status: "idle" })).context).toBeNull();
    const st = fold(
      stream(
        { kind: "context_usage", usedTokens: 12_000, maxTokens: 200_000, percentage: 6, autoCompact: true },
        { kind: "context_usage", usedTokens: 96_000, maxTokens: 200_000, percentage: 48 },
      ),
    );
    expect(st.context).toEqual({ usedTokens: 96_000, maxTokens: 200_000, percentage: 48, autoCompact: false });
  });
});
