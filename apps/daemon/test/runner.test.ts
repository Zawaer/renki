import type { Attachment, EventPayload } from "@crc/protocol";
import { describe, expect, it } from "vitest";
import {
  classifyRateLimit,
  handleAssistantMessage,
  handleStreamEvent,
  singlePromptStream,
  summarizeResultError,
} from "../src/claude/runner.js";

async function firstMessage(text: string, attachments?: Attachment[]) {
  const gen = singlePromptStream(text, attachments);
  const { value } = await gen.next();
  return value!;
}

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
 * singlePromptStream builds the actual Messages-API content the model sees.
 * Attachments are always base64 on the wire regardless of kind, but only
 * images/PDFs want base64 in the content block itself — a text/plain
 * attachment's DocumentBlockParam wants the decoded text, so that's the one
 * shape worth pinning down here.
 */
describe("singlePromptStream", () => {
  it("sends a plain string when there are no attachments (preserves streaming-input-mode-only behavior)", async () => {
    const msg = await firstMessage("hello");
    expect(msg.message.content).toBe("hello");
  });

  it("puts image/PDF attachments before the text block, base64 untouched", async () => {
    const png: Attachment = { name: "shot.png", mediaType: "image/png", data: "cGFrZQ==" };
    const pdf: Attachment = { name: "doc.pdf", mediaType: "application/pdf", data: "cGFrZQ==" };
    const msg = await firstMessage("what is this?", [png, pdf]);

    expect(msg.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "cGFrZQ==" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGFrZQ==" }, title: "doc.pdf" },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("decodes a text/plain attachment's base64 into the document block's plain-text source", async () => {
    const text: Attachment = { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello world").toString("base64") };
    const msg = await firstMessage("summarize", [text]);

    expect(msg.message.content).toEqual([
      { type: "document", source: { type: "text", media_type: "text/plain", data: "hello world" }, title: "notes.txt" },
      { type: "text", text: "summarize" },
    ]);
  });

  it("omits the text block entirely for an attachment-only prompt (no caption)", async () => {
    const png: Attachment = { name: "shot.png", mediaType: "image/png", data: "cGFrZQ==" };
    const msg = await firstMessage("", [png]);

    expect(msg.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "cGFrZQ==" } }]);
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
    for (const e of events) handleStreamEvent(e, "t1", blockKinds, 0, null, (p) => emitted.push(p));
    handleAssistantMessage(finalMessage, "t1", blockKinds, 0, { parentToolUseId: null }, (p) => emitted.push(p));
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
      null,
      (p) => emittedA.push(p),
    );
    handleAssistantMessage(
      { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      "t1",
      blockKindsA,
      0,
      { parentToolUseId: null },
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
      null,
      (p) => emittedB.push(p),
    );
    handleAssistantMessage(
      { content: [{ type: "tool_use", id: "tu_2", name: "Read", input: {} }] },
      "t1",
      blockKindsB,
      offsetAfterA,
      { parentToolUseId: null },
      (p) => emittedB.push(p),
    );

    const indexA = emittedA.find((e) => e.kind === "assistant_block") as { blockIndex: number };
    const indexB = emittedB.find((e) => e.kind === "assistant_block") as { blockIndex: number };
    expect(indexA.blockIndex).not.toBe(indexB.blockIndex);
  });
});

/**
 * With forwardSubagentText on, a subagent's own messages arrive interleaved
 * with the main agent's, tagged with parentToolUseId. Real runTurn gives each
 * (sub)agent its own independent { blockKinds, globalOffset } tracker (see
 * `agentTracking` there) precisely so this doesn't happen — this is the same
 * scenario at the handleAssistantMessage level, one tracker per agent.
 */
describe("subagent-tagged blocks (forwardSubagentText)", () => {
  it("carries parentToolUseId/subagentType/taskDescription only on the subagent's own blocks", () => {
    const mainKinds = new Map<number, "text" | "thinking" | "tool_use">();
    const mainEmitted: EventPayload[] = [];
    // Main agent's turn opens with the Task tool_use call (global index 0).
    handleAssistantMessage(
      { content: [{ type: "tool_use", id: "tu_task", name: "Task", input: { description: "Explore the repo" } }] },
      "t1",
      mainKinds,
      0,
      { parentToolUseId: null },
      (p) => mainEmitted.push(p),
    );

    const subKinds = new Map<number, "text" | "thinking" | "tool_use">();
    const subEmitted: EventPayload[] = [];
    // The subagent's own forwarded text, using a COMPLETELY SEPARATE tracker
    // (its own globalOffset starts at 0, independent of the main agent's).
    handleAssistantMessage(
      { content: [{ type: "text", text: "Found 3 matching files." }] },
      "t1",
      subKinds,
      0,
      { parentToolUseId: "tu_task", subagentType: "Explore", taskDescription: "Explore the repo" },
      (p) => subEmitted.push(p),
    );

    // Main agent continues (a new "assistant" message once the Task tool_result
    // lands) — must pick up at global index 1, unaffected by the subagent's
    // own block count.
    handleAssistantMessage(
      { content: [{ type: "text", text: "Here's what I found." }] },
      "t1",
      mainKinds,
      1, // globalOffset as runTurn would compute it: max(mainKinds keys) + 1 = 1
      { parentToolUseId: null },
      (p) => mainEmitted.push(p),
    );

    expect(mainEmitted.every((e) => !("parentToolUseId" in e))).toBe(true);
    const mainIndices = mainEmitted.map((e) => (e as { blockIndex: number }).blockIndex);
    expect(mainIndices).toEqual([0, 1]);

    expect(subEmitted).toEqual([
      {
        kind: "assistant_block",
        turnId: "t1",
        blockIndex: 0,
        blockKind: "text",
        text: "Found 3 matching files.",
        toolUseId: null,
        toolName: null,
        toolInput: null,
        parentToolUseId: "tu_task",
        subagentType: "Explore",
        taskDescription: "Explore the repo",
      },
    ]);
  });
});

describe("thinking block duration", () => {
  it("stamps a thinking block with how long it streamed, so replay can show it", () => {
    const events: EventPayload[] = [];
    const blockKinds = new Map<number, "text" | "thinking" | "tool_use">();
    const startedAt = new Map<number, number>();
    // The stream opens the block ~3s ago; the finalized message lands now.
    handleStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }, "t1", blockKinds, 0, null, (p) => events.push(p), startedAt);
    startedAt.set(0, Date.now() - 3000);
    handleAssistantMessage(
      { content: [{ type: "thinking", thinking: "weighing options" }] },
      "t1",
      blockKinds,
      0,
      { parentToolUseId: null },
      (p) => events.push(p),
      startedAt,
    );
    const block = events.find((e) => e.kind === "assistant_block") as { durationMs?: number };
    expect(block.durationMs).toBeGreaterThanOrEqual(3000);
    expect(block.durationMs).toBeLessThan(3500);
  });

  it("omits the duration when the block never streamed", () => {
    const events: EventPayload[] = [];
    const blockKinds = new Map<number, "text" | "thinking" | "tool_use">([[0, "thinking"]]);
    handleAssistantMessage({ content: [{ type: "thinking", thinking: "x" }] }, "t1", blockKinds, 0, { parentToolUseId: null }, (p) => events.push(p));
    expect((events[0] as { durationMs?: number }).durationMs).toBeUndefined();
  });
});
