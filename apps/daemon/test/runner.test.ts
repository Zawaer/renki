import type { EventPayload } from "@crc/protocol";
import { describe, expect, it } from "vitest";
import { classifyRateLimit, handleAssistantMessage, handleStreamEvent, summarizeResultError } from "../src/claude/runner.js";

/**
 * classifyRateLimit is the trigger for automatic multi-account rotation: a turn
 * that trips it gets retried once on a switched account. False positives would
 * burn a switch needlessly; false negatives would strand a user on an exhausted
 * account. So the heuristic's boundaries are worth pinning down.
 */
describe("classifyRateLimit", () => {
  it("returns false for empty / missing text", () => {
    expect(classifyRateLimit(null)).toBe(false);
    expect(classifyRateLimit(undefined)).toBe(false);
    expect(classifyRateLimit("")).toBe(false);
  });

  it("matches the known usage/limit phrasings, case-insensitively", () => {
    const hits = [
      "Rate limit exceeded",
      "rate-limited, try again",
      "You hit your usage limit",
      "usage limit reached",
      "limit exceeded for this account",
      "You have exceeded your usage",
      "429 Too Many Requests",
      "too many requests",
    ];
    for (const text of hits) expect(classifyRateLimit(text), text).toBe(true);
  });

  it("does not fire on unrelated errors", () => {
    const misses = [
      "ENOENT: no such file or directory",
      "worktree add failed: branch already exists",
      "Model overloaded, please retry",
      "connection reset by peer",
      "syntax error near unexpected token",
    ];
    for (const text of misses) expect(classifyRateLimit(text), text).toBe(false);
  });
});

/**
 * The SDK's error-shaped result variant carries `errors: string[]`, but
 * account-level failures (e.g. hitting a spend limit) arrive on the
 * "success"-shaped variant instead: subtype "success", is_error true, no
 * `errors` array — only a `result` string with the actual message.
 */
describe("summarizeResultError", () => {
  it("prefers errors[] when present", () => {
    expect(summarizeResultError({ subtype: "error_during_execution", errors: ["boom", "again"] })).toBe("boom; again");
  });

  it("falls back to result text on the success-shaped error variant", () => {
    expect(
      summarizeResultError({ subtype: "success", result: "You've hit your monthly spend limit. /model to switch models." }),
    ).toBe("You've hit your monthly spend limit. /model to switch models.");
  });

  it("falls back to the bare subtype only when neither errors nor result is present", () => {
    expect(summarizeResultError({ subtype: "success" })).toBe("success");
  });

  it("ignores a blank result string", () => {
    expect(summarizeResultError({ subtype: "success", result: "   " })).toBe("success");
  });
});

/**
 * handleStreamEvent numbers blocks from the raw Anthropic stream (which
 * counts every content block, including thinking); handleAssistantMessage
 * renumbers the SAME message's blocks from its own `content` array, which can
 * omit a thinking block entirely. Left alone, that mismatch hands the same
 * answer two different indices — one from the streamed deltas, one from the
 * canonical finish — so both survive in the reducer's blocks array and the
 * UI renders the answer twice. Regression coverage for that bug.
 */
describe("handleStreamEvent / handleAssistantMessage block indexing", () => {
  function run(events: unknown[], finalMessage: unknown) {
    const emitted: EventPayload[] = [];
    const blockKinds = new Map<number, "text" | "thinking" | "tool_use">();
    for (const e of events) handleStreamEvent(e, "t1", blockKinds, 0, (p) => emitted.push(p));
    handleAssistantMessage(finalMessage, "t1", blockKinds, 0, (p) => emitted.push(p));
    return emitted;
  }

  it("keeps a thinking-then-text message at one shared index, not two", () => {
    const emitted = run(
      [
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Full answer." } },
      ],
      // The finalized message omits the thinking block from `content` — this is
      // the real shape that triggered the bug.
      { content: [{ type: "text", text: "Full answer." }] },
    );

    const textIndices = new Set(
      emitted.filter((e) => "blockKind" in e && e.blockKind === "text").map((e) => (e as { blockIndex: number }).blockIndex),
    );
    expect(textIndices).toEqual(new Set([1]));
  });

  it("gives each message in a multi-tool-call turn its own non-colliding indices", () => {
    // Message A: a lone tool_use (local index 0, per Anthropic's per-message numbering).
    const blockKindsA = new Map<number, "text" | "thinking" | "tool_use">();
    const emittedA: EventPayload[] = [];
    handleStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use" } },
      "t1",
      blockKindsA,
      0,
      (p) => emittedA.push(p),
    );
    handleAssistantMessage(
      { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      "t1",
      blockKindsA,
      0,
      (p) => emittedA.push(p),
    );
    const offsetAfterA = (blockKindsA.size > 0 ? Math.max(...blockKindsA.keys()) : -1) + 1;

    // Message B: another lone tool_use, ALSO at local index 0 — but this is a
    // fresh message, so it must land at a NEW global index, not collide with A's.
    const blockKindsB = new Map<number, "text" | "thinking" | "tool_use">();
    const emittedB: EventPayload[] = [];
    handleStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use" } },
      "t1",
      blockKindsB,
      offsetAfterA,
      (p) => emittedB.push(p),
    );
    handleAssistantMessage(
      { content: [{ type: "tool_use", id: "tu_2", name: "Read", input: {} }] },
      "t1",
      blockKindsB,
      offsetAfterA,
      (p) => emittedB.push(p),
    );

    const indexA = emittedA.find((e) => e.kind === "assistant_block") as { blockIndex: number };
    const indexB = emittedB.find((e) => e.kind === "assistant_block") as { blockIndex: number };
    expect(indexA.blockIndex).not.toBe(indexB.blockIndex);
  });
});
