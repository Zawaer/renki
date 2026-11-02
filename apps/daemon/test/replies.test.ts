import { describe, expect, it } from "vitest";
import { SUGGEST_REPLIES_TOOL, createRepliesGuardHook, createRepliesStopHook, replyStateAfter } from "../src/claude/replies.js";

const run = (extra: Record<string, unknown> = {}) =>
  createRepliesStopHook().hooks[0]!(
    { hook_event_name: "PostToolUse", tool_name: SUGGEST_REPLIES_TOOL, tool_input: {}, tool_response: {}, session_id: "s", transcript_path: "", cwd: "/", ...extra } as never,
    "toolu_1",
    { signal: new AbortController().signal },
  );

describe("createRepliesStopHook", () => {
  it("ends the turn once the buttons are shown, so Claude can't write the reply again", async () => {
    expect(await run()).toMatchObject({ continue: false });
  });

  it("lets a subagent that calls it carry on", async () => {
    expect(await run({ agent_id: "a1" })).toEqual({ continue: true });
  });
});

const guard = (hasReply: boolean, extra: Record<string, unknown> = {}) =>
  createRepliesGuardHook(() => hasReply).hooks[0]!(
    { hook_event_name: "PreToolUse", tool_name: SUGGEST_REPLIES_TOOL, tool_input: {}, session_id: "s", transcript_path: "", cwd: "/", ...extra } as never,
    "toolu_1",
    { signal: new AbortController().signal },
  );

describe("createRepliesGuardHook", () => {
  it("refuses buttons with no reply above them", async () => {
    expect(await guard(false)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("lets them through once a reply was written", async () => {
    expect(await guard(true)).toEqual({ continue: true });
  });

  it("leaves subagents alone", async () => {
    expect(await guard(false, { agent_id: "a1" })).toEqual({ continue: true });
  });
});

describe("replyStateAfter", () => {
  const start = (type: string, name?: string) => ({ type: "content_block_start", index: 0, content_block: { type, name } });
  const delta = (type: string, text: string) => ({ type: "content_block_delta", index: 0, delta: { type, [type === "text_delta" ? "text" : "thinking"]: text } });

  it("counts visible text as a reply, not thinking or whitespace", () => {
    expect(replyStateAfter(delta("text_delta", "Here are the options"))).toBe(true);
    expect(replyStateAfter(delta("thinking_delta", "The options are"))).toBeUndefined();
    expect(replyStateAfter(delta("text_delta", "\n\n"))).toBeUndefined();
  });

  it("resets on a tool call, except suggest_replies itself", () => {
    expect(replyStateAfter(start("tool_use", "Bash"))).toBe(false);
    expect(replyStateAfter(start("tool_use", SUGGEST_REPLIES_TOOL))).toBeUndefined();
    expect(replyStateAfter(start("text"))).toBeUndefined();
  });
});
